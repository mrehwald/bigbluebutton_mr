/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

'use strict'

const C = require('../bbb/messages/Constants');
const MediaHandler = require('../media-handler');
const Messaging = require('../bbb/messages/Messaging');
const moment = require('moment');
const h264_sdp = require('../h264-sdp');
const now = moment();
const MCSApi = require('../mcs-core/lib/media/MCSApiStub');
const config = require('config');
const kurentoIp = config.get('kurentoIp');
const localIpAddress = config.get('localIpAddress');
const FORCE_H264 = config.get('screenshare-force-h264');
const PREFERRED_H264_PROFILE = config.get('screenshare-preferred-h264-profile');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../utils/Logger');
const SHOULD_RECORD = config.get('recordScreenSharing');
const KEYFRAME_INTERVAL = config.get('screenshareKeyframeInterval');

// Global MCS endpoints mapping. These hashes maps IDs generated by the mcs-core
// lib to the ones generate in the ScreenshareManager
var sharedScreens = {};
var rtpEndpoints = {};

module.exports = class Screenshare extends EventEmitter {
  constructor(id, bbbgw, voiceBridge, caller = 'caller', vh, vw, meetingId) {
    super();
    this.mcs = new MCSApi();
    this._id = id;
    this._BigBlueButtonGW = bbbgw;
    this._presenterEndpoint = null;
    this._ffmpegEndpoint = null;
    this._voiceBridge = voiceBridge;
    this._meetingId = meetingId;
    this._caller = caller;
    this._streamUrl = "";
    this._vw = vw;
    this._vh = vh;
    this._presenterCandidatesQueue = [];
    this._viewersEndpoint = [];
    this._viewersCandidatesQueue = [];
    this._status = C.MEDIA_STOPPED;
    this._rtmpBroadcastStarted = false;
    this.recording = {};
    this.isRecorded = false;

    this._BigBlueButtonGW.on(C.RECORDING_STATUS_REPLY_MESSAGE_2x+meetingId, (payload) => {
      Logger.info("[Screenshare] RecordingStatusReply ", payload.recorded);

      if (payload.recorded) {
        this.isRecorded = true;
      }
    });
  }

  async onIceCandidate (candidate, role, callerName) {
    Logger.debug("[screenshare] onIceCandidate", role, callerName, candidate);
    switch (role) {
      case C.SEND_ROLE:
        if (this._presenterEndpoint) {
          try {
            await this.flushCandidatesQueue(this._presenterEndpoint, this._presenterCandidatesQueue);
            await this.mcs.addIceCandidate(this._presenterEndpoint, candidate);
          } catch (err) {
            Logger.error("[screenshare] ICE candidate could not be added to media controller.", err);
          }
        } else {
          Logger.debug("[screenshare] Pushing ICE candidate to presenter queue");
          this._presenterCandidatesQueue.push(candidate);
        }
      case C.RECV_ROLE:
        let endpoint = this._viewersEndpoint[callerName];
        if (endpoint) {
          try {
            await this.flushCandidatesQueue(endpoint, this._viewersCandidatesQueue[callerName]);
            await this.mcs.addIceCandidate(endpoint, candidate);
          } catch (err) {
            Logger.error("[screenshare] Viewer ICE candidate could not be added to media controller.", err);
          }
        } else {
          this._viewersCandidatesQueue[callerName] = [];
          Logger.debug("[screenshare] Pushing ICE candidate to viewer queue", callerName);
          this._viewersCandidatesQueue[callerName].push(candidate);
        }
        break;
      default:
        Logger.warn("[screenshare] Unknown role", role);
      }
  }

  flushCandidatesQueue (mediaId, queue) {
    return new Promise((resolve, reject) => {
      Logger.debug("[screenshare] flushCandidatesQueue", queue);
      if (mediaId) {
        let iceProcedures = queue.map((candidate) => {
          this.mcs.addIceCandidate(mediaId, candidate);
        });

        return Promise.all(iceProcedures).then(() => {
          queue = [];
          resolve();
        }).catch((err) => {
          Logger.error("[screenshare] ICE candidate could not be added to media controller.", err);
          reject();
        });
      }
    });
  }

  mediaStateRtp (event) {
    let msEvent = event.event;

    switch (event.eventTag) {
      case "MediaStateChanged":
        break;

      case "MediaFlowOutStateChange":
        Logger.info('[screenshare]', msEvent.type, '[' + msEvent.state? msEvent.state : 'UNKNOWN_STATE' + ']', 'for media session ',  event.id);
        break;

      case "MediaFlowInStateChange":
        Logger.info('[screenshare]', msEvent.type, '[' + msEvent.state? msEvent.state : 'UNKNOWN_STATE' + ']', 'for media session ',  event.id);
        if (msEvent.state === 'FLOWING') {
          this._onRtpMediaFlowing();
        }
        else {
          this._onRtpMediaNotFlowing();
        }
        break;

      default: Logger.warn("[screenshare] Unrecognized event", event);
    }
  }

  mediaStateWebRtc (event, id) {
    let msEvent = event.event;

    switch (event.eventTag) {
      case "OnIceCandidate":
        let candidate = msEvent.candidate;
        Logger.debug('[screenshare] Received ICE candidate from mcs-core for media session', event.id, '=>', candidate, "for connection", id);

        this._BigBlueButtonGW.publish(JSON.stringify({
          connectionId: id,
          type: C.SCREENSHARE_APP,
          id : 'iceCandidate',
          cameraId: this._id,
          candidate : candidate
        }), C.FROM_SCREENSHARE);

        break;

      case "MediaStateChanged":
        break;

      case "MediaFlowOutStateChange":
      case "MediaFlowInStateChange":
        Logger.info('[screenshare]', msEvent.type, '[' + msEvent.state? msEvent.state : 'UNKNOWN_STATE' + ']', 'for media session',  event.id);
        break;

      default: Logger.warn("[screenshare] Unrecognized event", event);
    }
  }

  serverState (event) {
    switch (event && event.eventTag) {
      case C.MEDIA_SERVER_OFFLINE:
        Logger.error("[screenshare] Screenshare provider received MEDIA_SERVER_OFFLINE event");
        this.emit(C.MEDIA_SERVER_OFFLINE, event);
        break;
      default:
        Logger.warn("[screenshare] Unknown server state", event);
    }
  }

  recordingState(event) {
    const msEvent = event.event;
    Logger.info('[Recording]', msEvent.type, '[', msEvent.state, ']', 'for recording session', event.id, 'for screenshare', this.streamName);
  }

  async startRecording() {
    return new Promise(async (resolve, reject) => {
      try {
        this.recording = await this.mcs.startRecording(this.userId, this._presenterEndpoint, this._voiceBridge);
        this.mcs.on('MediaEvent' + this.recording.recordingId, this.recordingState.bind(this));
        this.sendStartShareEvent();
        resolve(this.recording);
      } catch (err) {
        Logger.error("[screenshare] Error on start recording with message", err);
        reject(err);
      }
    });
  }

  sendStartShareEvent () {
    let shareEvent = Messaging.generateWebRTCShareEvent('StartWebRTCDesktopShareEvent', this.recording.meetingId, this.recording.filename);
    this._BigBlueButtonGW.writeMeetingKey(this.recording.meetingId, shareEvent, function(error) {
      Logger.warn('[screenshare] Error writing START share event error', error);
    });
  }

  sendStopShareEvent () {
    let shareEvent = Messaging.generateWebRTCShareEvent('StopWebRTCDesktopShareEvent', this.recording.meetingId, this.recording.filename);
    this._BigBlueButtonGW.writeMeetingKey(this.recording.meetingId, shareEvent, function(error) {
      Logger.warn('[screenshare] Error writing STOP share event error', error);
    });
  }

  sendGetRecordingStatusRequestMessage(userId) {
    let req = Messaging.generateRecordingStatusRequestMessage(this._meetingId, userId);

    this._BigBlueButtonGW.publish(req, C.TO_AKKA_APPS);
  }

  start (sessionId, connectionId, sdpOffer, callerName, role) {
    return new Promise(async (resolve, reject) => {
      // Forces H264 with a possible preferred profile
      if (FORCE_H264) {
        sdpOffer = h264_sdp.transform(sdpOffer, PREFERRED_H264_PROFILE);
      }

      // Start the recording process
      if (SHOULD_RECORD && role === C.SEND_ROLE) {
        this.sendGetRecordingStatusRequestMessage(callerName);
      }

      Logger.info("[screenshare] Starting session", this._voiceBridge + '-' + role);
      if (!this.userId) {
        try {
          this.userId = await this.mcs.join(this._meetingId, 'SFU', {});
          Logger.info("[screenshare] MCS Join for", this._id, "returned", this.userId);

        }
        catch (error) {
          Logger.error("[screenshare] MCS Join returned error =>", error);
          return reject (error);
        }
      }

      if (role === C.RECV_ROLE) {
        try {
          const sdpAnswer = await this._startViewer(connectionId, this._voiceBridge, sdpOffer, callerName, this._presenterEndpoint)
          return resolve(sdpAnswer);
        }
        catch (err) {
          return reject(err);
        }
      }

      if (role === C.SEND_ROLE) {
        try {
          const sdpAnswer = await this._startPresenter(sdpOffer);
          return resolve(sdpAnswer);
        }
        catch (err) {
          return reject(err);
        }
      }
    });
  }

  _startPresenter (sdpOffer) {
    return new Promise(async (resolve, reject) => {
      try {
        const retSource = await this.mcs.publish(this.userId, this._meetingId, 'WebRtcEndpoint', {descriptor: sdpOffer});

        this._presenterEndpoint = retSource.sessionId;
        sharedScreens[this._voiceBridge] = this._presenterEndpoint;
        let presenterSdpAnswer = retSource.answer;
        await this.flushCandidatesQueue(this._presenterEndpoint, this._presenterCandidatesQueue);

        this.mcs.on('MediaEvent' + this._presenterEndpoint, (event) => {
          this.mediaStateWebRtc(event, this._id)
        });

        Logger.info("[screenshare] MCS publish for user", this.userId, "returned", this._presenterEndpoint);

        let sendVideoPort = MediaHandler.getVideoPort();
        let rtpSdpOffer = MediaHandler.generateVideoSdp(localIpAddress, sendVideoPort);

        const retRtp = await this.mcs.subscribe(this.userId, sharedScreens[this._voiceBridge], 'RtpEndpoint', { descriptor: rtpSdpOffer, keyframeInterval: KEYFRAME_INTERVAL});

        this._ffmpegEndpoint = retRtp.sessionId;
        rtpEndpoints[this._voiceBridge] = this._ffmpegEndpoint;

        let recvVideoPort = retRtp.answer.match(/m=video\s(\d*)/)[1];
        this._rtpParams = MediaHandler.generateTranscoderParams(kurentoIp, localIpAddress,
          sendVideoPort, recvVideoPort, this._meetingId, "stream_type_video", C.RTP_TO_RTMP, "copy", this._caller, this._voiceBridge);

        this.mcs.on('MediaEvent' + this._ffmpegEndpoint, this.mediaStateRtp.bind(this));

        Logger.info("[screenshare] MCS subscribe for user", this.userId, "returned", this._ffmpegEndpoint);

        return resolve(presenterSdpAnswer);
      }
      catch (err) {
        Logger.error("[screenshare] MCS publish returned error =>", err);
        return reject(err);
      }
      finally {
        this.mcs.once('ServerState' + this._presenterEndpoint, this.serverState.bind(this));
      }
    });
  }

  _startViewer(connectionId, voiceBridge, sdpOffer, callerName, presenterEndpoint) {
    return new Promise(async (resolve, reject) => {
      Logger.info("[screenshare] Starting viewer", callerName, "for voiceBridge", this._voiceBridge);
      let sdpAnswer;

      this._viewersCandidatesQueue[callerName] = [];

      try {
        const retSource = await this.mcs.subscribe(this.userId, sharedScreens[voiceBridge], 'WebRtcEndpoint', {descriptor: sdpOffer});

        this._viewersEndpoint[callerName] = retSource.sessionId;
        sdpAnswer = retSource.answer;
        await this.flushCandidatesQueue(this._viewersEndpoint[callerName], this._viewersCandidatesQueue[callerName]);

        this.mcs.on('MediaEvent' + this._viewersEndpoint[callerName], (event) => {
          this.mediaStateWebRtc(event, connectionId);
        });

        Logger.info("[screenshare] MCS subscribe returned for user", this.userId, "returned", this._viewersEndpoint[callerName], "at callername", callerName);
        return resolve(sdpAnswer);
      }
      catch (err) {
        Logger.error("[screenshare] MCS publish returned error =>", err);
        return reject(err);
      }
    });
  }

  stop () {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info('[screnshare] Stopping and releasing endpoints for MCS user', this.userId);
        await this._stopScreensharing();
        this._status = C.MEDIA_STOPPED;

        Logger.info("[screenshare] Leaving mcs room");
        await this.mcs.leave(this._meetingId, this.userId);
        delete sharedScreens[this._presenterEndpoint];
        this._candidatesQueue = null;
        this._presenterEndpoint = null;
        this._ffmpegEndpoint = null;
        if (this.isRecorded) {
          this.sendStopShareEvent();
        }
        return resolve();
      }
      catch (err) {
        Logger.error('[screenshare] MCS returned an error when trying to leave =>', err);
        return resolve();
      }
    });
  }

  _stopScreensharing() {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info("[screenshare] Stopping screensharing with status", this._status);
        const isTranscoderAvailable = await this._BigBlueButtonGW.isChannelAvailable(C.TO_BBB_TRANSCODE_SYSTEM_CHAN);
        const strm = Messaging.generateStopTranscoderRequestMessage(this._meetingId, this._meetingId);


        if (isTranscoderAvailable) {
          // Interoperability: capturing 1.1 stop_transcoder_reply messages
          this._BigBlueButtonGW.once(C.STOP_TRANSCODER_REPLY+this._meetingId, async (payload) => {
            const meetingId = payload[C.MEETING_ID];
            await this._stopRtmpBroadcast(meetingId);
            return resolve();
          });

          // Capturing stop transcoder responses from the 2x model
          this._BigBlueButtonGW.once(C.STOP_TRANSCODER_RESP_2x+this._meetingId, async (payload) => {
            const meetingId = payload[C.MEETING_ID_2x];
            await this._stopRtmpBroadcast(meetingId);
            return resolve();
          });

          this._BigBlueButtonGW.publish(strm, C.TO_BBB_TRANSCODE_SYSTEM_CHAN, function(error) {});
        }

        // Either the transcoder is not available or screensharing couldn't be
        // correctly started
        if (this._status != C.MEDIA_STARTED || !isTranscoderAvailable) {
          this._stopRtmpBroadcast(this._meetingId);
          return resolve();
        }
      }
      catch (err) {
        Logger.error(err);
        resolve();
      }
    });
  }

  async _onRtpMediaFlowing() {
    if (!this._rtmpBroadcastStarted) {
      Logger.info("[screenshare] RTP Media FLOWING for meeting", this._meetingId);
      const isTranscoderAvailable = await this._BigBlueButtonGW.isChannelAvailable(C.TO_BBB_TRANSCODE_SYSTEM_CHAN);
      const strm = Messaging.generateStartTranscoderRequestMessage(this._meetingId, this._meetingId, this._rtpParams);

      // Checking if transcoder is avaiable; if so, transposes the stream to RTMP
      if (isTranscoderAvailable) {
        // Interoperability: capturing 1.1 start_transcoder_reply messages
        this._BigBlueButtonGW.once(C.START_TRANSCODER_REPLY+this._meetingId, (payload) => {
          let meetingId = payload[C.MEETING_ID];
          let output = payload["params"].output;
          this._startRtmpBroadcast(meetingId, output);
        });

        // Capturing stop transcoder responses from the 2x model
        this._BigBlueButtonGW.once(C.START_TRANSCODER_RESP_2x+this._meetingId, (payload) => {
          let meetingId = payload[C.MEETING_ID_2x];
          let output = payload["params"].output;
          this._startRtmpBroadcast(meetingId, output);
        });

        this._BigBlueButtonGW.publish(strm, C.TO_BBB_TRANSCODE_SYSTEM_CHAN, function(error) {});
      } else {
        // transcoder is not available, pure WebRTC environment
        this._startRtmpBroadcast(this._meetingId);
      }

      if (this._status != C.MEDIA_STARTED) {
        Logger.info('[screenshare] webRTC started flowing for meeting', this._meetingId);
        if (this.isRecorded) {
          this.startRecording();
        }
        this._status = C.MEDIA_STARTED;
      }
    }
  };

  _stopRtmpBroadcast (meetingId) {
    return new Promise((resolve, reject) => {
      Logger.info("[screenshare] _stopRtmpBroadcast for meeting", meetingId);
      let timestamp = now.format('hhmmss');
      let dsrstom = Messaging.generateScreenshareRTMPBroadcastStoppedEvent2x(this._voiceBridge,
        this._voiceBridge, this._streamUrl, this._vw, this._vh, timestamp);
      this._BigBlueButtonGW.publish(dsrstom, C.FROM_VOICE_CONF_SYSTEM_CHAN);
      resolve();
    });
  }

  _startRtmpBroadcast (meetingId, output) {
    Logger.info("[screenshare] _startRtmpBroadcast for meeting", + meetingId);
    let timestamp = now.format('hhmmss');
    this._streamUrl = MediaHandler.generateStreamUrl(localIpAddress, meetingId, output);
    let dsrbstam = Messaging.generateScreenshareRTMPBroadcastStartedEvent2x(this._voiceBridge,
      this._voiceBridge, this._streamUrl, this._vw, this._vh, timestamp);

    this._BigBlueButtonGW.publish(dsrbstam, C.FROM_VOICE_CONF_SYSTEM_CHAN, function(error) {});
    this._rtmpBroadcastStarted = true;
  }

  _onRtpMediaNotFlowing() {
    Logger.warn("[screenshare] TODO RTP NOT_FLOWING");
  }

  async stopViewer(id) {
    let viewer = this._viewersEndpoint[id];
    Logger.info('[screenshare] Releasing endpoints for', viewer);

    if (viewer) {
      try {
        await this.mcs.unsubscribe(this.userId, this.viewer);
        this._viewersCandidatesQueue[id] = null;
        this._viewersEndpoint[id] = null;
        return;
      }
      catch (err) {
        Logger.error('[screenshare] MCS returned error when trying to unsubscribe', err);
        return;
      }
    }
  }
};

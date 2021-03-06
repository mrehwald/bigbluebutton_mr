/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

"use strict";

const BigBlueButtonGW = require('../bbb/pubsub/bbb-gw');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const isRecordedStream = require('../utils/Utils.js').isRecordedStream;

module.exports = class BaseManager {
  constructor (connectionChannel, additionalChannels = [], logPrefix = C.BASE_MANAGER_PREFIX) {
    this._sessions = {};
    this._bbbGW = new BigBlueButtonGW();
    this._redisGateway;
    this._connectionChannel = connectionChannel;
    this._additionalChanels = additionalChannels;
    this._logPrefix = logPrefix;
    this._iceQueues = {};
  }

  async start() {
    try {
      // Additional channels that this manager is going to use
      this._additionalChanels.forEach((channel) => {
        this._bbbGW.addSubscribeChannel(channel);
      });
    }
    catch (error) {
      Logger.error(this._logPrefix, 'Could not connect to Redis channel', error);
      await this.stopAll();
      throw new Error(error);
    }
  }

  async messageFactory (handler) {
    // Entrypoint for messages to the manager (from the connection-manager/ws module
    this._redisGateway = await this._bbbGW.addSubscribeChannel(this._connectionChannel);
    this._redisGateway.on(C.REDIS_MESSAGE, handler.bind(this));
  }

  _fetchSession (sessionId) {
    return this._sessions[sessionId];
  }

  _fetchIceQueue (sessionId) {
    if (this._iceQueues[sessionId] == null) {
      this._iceQueues[sessionId] = [];
    }

    return this._iceQueues[sessionId] ;
  }

  _flushIceQueue (session, queue) {
    if (queue) {
      let candidate;
      while(candidate = queue.pop()) {
        session.onIceCandidate(candidate);
      }
    }
  }

  _killConnectionSessions (connectionId) {
    const keys = Object.keys(this._sessions);
    keys.forEach((sessionId) => {
      let session = this._sessions[sessionId];
      if(session && session.connectionId === connectionId) {
        let killedSessionId = session.connectionId + session.id + "-" + session.role;
        this._stopSession(killedSessionId);
      }
    });
  }

  _stopSession (sessionId) {
    return new Promise(async (resolve, reject) => {
      Logger.info(this._logPrefix, 'Stopping session ' + sessionId);
      try {
        if (this._sessions == null|| sessionId == null) {
          return resolve();
        }

        let session = this._sessions[sessionId];
        if(session) {
          if (typeof session.stop === 'function') {
            await session.stop();
          }
          delete this._sessions[sessionId];
          this._logAvailableSessions();
          return resolve();
        }
      }
      catch (err) {
        Logger.error(err);
        return resolve();
      }
    });
  }

  stopAll() {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info(this._logPrefix, 'Stopping everything! ');
        if (this._sessions == null) {
          return resolve;
        }

        let sessionIds = Object.keys(this._sessions);
        let stopProcedures = [];

        for (let i = 0; i < sessionIds.length; i++) {
          stopProcedures.push(this._stopSession(sessionIds[i]));
        }
        resolve(Promise.all(stopProcedures));
      }
      catch (err) {
        Logger.error(error);
        resolve();
      }
    });
  }

  _logAvailableSessions () {
    if(this._sessions) {
      let sessionMainKeys = Object.keys(this._sessions);
      let logInfo = this._logPrefix + 'There are ' + sessionMainKeys.length + ' sessions available =>\n';
      for (var k in this._sessions) {
        if(this._sessions[k]) {
          logInfo += '(Session[' +  k +']' + ' of type ' + this._sessions[k].constructor.name + ');\n';
        }
      }
      Logger.debug(logInfo);
    }
  }
};

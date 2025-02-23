/* global $ */

import { getLogger } from 'jitsi-meet-logger';
import { $msg, $pres, Strophe } from 'strophe.js';
import 'strophejs-plugin-disco';

import RandomUtil from '../util/RandomUtil';
import * as JitsiConnectionErrors from '../../JitsiConnectionErrors';
import * as JitsiConnectionEvents from '../../JitsiConnectionEvents';
import browser from '../browser';
import initEmuc from './strophe.emuc';
import initJingle from './strophe.jingle';
import initStropheUtil from './strophe.util';
import initPing from './strophe.ping';
import initRayo from './strophe.rayo';
import initStropheLogger from './strophe.logger';
import LastSuccessTracker from './StropheBoshLastSuccess';
import Listenable from '../util/Listenable';
import Caps from './Caps';
import GlobalOnErrorHandler from '../util/GlobalOnErrorHandler';
import XMPPEvents from '../../service/xmpp/XMPPEvents';

const logger = getLogger(__filename);

/**
 *
 * @param token
 * @param bosh
 */
function createConnection(token, bosh = '/http-bind') {
    // Append token as URL param
    if (token) {
        // eslint-disable-next-line no-param-reassign
        bosh += `${bosh.indexOf('?') === -1 ? '?' : '&'}token=${token}`;
    }

    const conn = new Strophe.Connection(bosh);

    // The default maxRetries is 5, which is too long.
    conn.maxRetries = 3;

    return conn;
}

// FIXME: remove once we have a default config template. -saghul
/**
 * A list of ice servers to use by default for P2P.
 */
export const DEFAULT_STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
];

/**
 * The name of the field used to recognize a chat message as carrying a JSON
 * payload from another endpoint.
 * If the json-message of a chat message contains a valid JSON object, and
 * the JSON has this key, then it is a valid json-message to be sent.
 */
export const JITSI_MEET_MUC_TYPE = 'type';

/**
 *
 */
export default class XMPP extends Listenable {
    /**
     * FIXME describe all options
     * @param {Object} options
     * @param {Array<Object>} options.p2pStunServers see
     * {@link JingleConnectionPlugin} for more details.
     * @param token
     */
    constructor(options, token) {
        super();
        this.connection = null;
        this.disconnectInProgress = false;
        this.connectionTimes = {};
        this.options = options;
        this.token = token;
        this.authenticatedUser = false;
        this._initStrophePlugins(this);

        this.connection = createConnection(token, options.bosh);

        this._lastSuccessTracker = new LastSuccessTracker();
        this._lastSuccessTracker.startTracking(this.connection);

        this.caps = new Caps(this.connection, this.options.clientNode);

        // Initialize features advertised in disco-info
        this.initFeaturesList();

        // Setup a disconnect on unload as a way to facilitate API consumers. It
        // sounds like they would want that. A problem for them though may be if
        // they wanted to utilize the connected connection in an unload handler
        // of their own. However, it should be fairly easy for them to do that
        // by registering their unload handler before us.
        $(window).on('beforeunload unload', ev => {
            this.disconnect(ev).catch(() => {
                // ignore errors in order to not brake the unload.
            });
        });
    }

    /**
     * Initializes the list of feature advertised through the disco-info
     * mechanism.
     */
    initFeaturesList() {
        // http://xmpp.org/extensions/xep-0167.html#support
        // http://xmpp.org/extensions/xep-0176.html#support
        this.caps.addFeature('urn:xmpp:jingle:1');
        this.caps.addFeature('urn:xmpp:jingle:apps:rtp:1');
        this.caps.addFeature('urn:xmpp:jingle:transports:ice-udp:1');
        this.caps.addFeature('urn:xmpp:jingle:apps:dtls:0');
        this.caps.addFeature('urn:xmpp:jingle:transports:dtls-sctp:1');
        this.caps.addFeature('urn:xmpp:jingle:apps:rtp:audio');
        this.caps.addFeature('urn:xmpp:jingle:apps:rtp:video');

        if (!this.options.disableRtx && browser.supportsRtx()) {
            this.caps.addFeature('urn:ietf:rfc:4588');
        }

        // this is dealt with by SDP O/A so we don't need to announce this
        // XEP-0293
        // this.caps.addFeature('urn:xmpp:jingle:apps:rtp:rtcp-fb:0');
        // XEP-0294
        // this.caps.addFeature('urn:xmpp:jingle:apps:rtp:rtp-hdrext:0');

        this.caps.addFeature('urn:ietf:rfc:5761'); // rtcp-mux
        this.caps.addFeature('urn:ietf:rfc:5888'); // a=group, e.g. bundle

        // this.caps.addFeature('urn:ietf:rfc:5576'); // a=ssrc

        // Enable Lipsync ?
        if (browser.isChrome() && this.options.enableLipSync !== false) {
            logger.info('Lip-sync enabled !');
            this.caps.addFeature('http://jitsi.org/meet/lipsync');
        }

        if (this.connection.rayo) {
            this.caps.addFeature('urn:xmpp:rayo:client:1');
        }
    }

    /**
     * Returns {@code true} if the PING functionality is supported by the server
     * or {@code false} otherwise.
     * @returns {boolean}
     */
    isPingSupported() {
        return this._pingSupported !== false;
    }

    /**
     *
     */
    getConnection() {
        return this.connection;
    }

    /**
     * Receive connection status changes and handles them.
     *
     * @param {Object} credentials
     * @param {string} credentials.jid - The user's XMPP ID passed to the
     * connect method. For example, 'user@xmpp.com'.
     * @param {string} credentials.password - The password passed to the connect
     * method.
     * @param {string} status - One of Strophe's connection status strings.
     * @param {string} [msg] - The connection error message provided by Strophe.
     */
    connectionHandler(credentials = {}, status, msg) {
        const now = window.performance.now();
        const statusStr = Strophe.getStatusString(status).toLowerCase();

        this.connectionTimes[statusStr] = now;
        logger.log(
            `(TIME) Strophe ${statusStr}${msg ? `[${msg}]` : ''}:\t`,
            now);

        this.eventEmitter.emit(XMPPEvents.CONNECTION_STATUS_CHANGED, credentials, status, msg);
        if (status === Strophe.Status.CONNECTED
            || status === Strophe.Status.ATTACHED) {
            if (this.options.useStunTurn
                || (this.options.p2p && this.options.p2p.useStunTurn)) {
                this.connection.jingle.getStunAndTurnCredentials();
            }

            logger.info(`My Jabber ID: ${this.connection.jid}`);

            // Schedule ping ?
            const pingJid = this.connection.domain;

            this.caps.getFeaturesAndIdentities(pingJid)
                .then(({ features, identities }) => {
                    if (features.has(Strophe.NS.PING)) {
                        this._pingSupported = true;
                        this.connection.ping.startInterval(pingJid);
                    } else {
                        logger.warn(`Ping NOT supported by ${pingJid}`);
                    }

                    // check for speakerstats
                    identities.forEach(identity => {
                        if (identity.type === 'speakerstats') {
                            this.speakerStatsComponentAddress = identity.name;

                            this.connection.addHandler(
                                this._onPrivateMessage.bind(this), null,
                                'message', null, null);
                        }
                    });
                })
                .catch(error => {
                    const errmsg = 'Feature discovery error';

                    GlobalOnErrorHandler.callErrorHandler(
                        new Error(`${errmsg}: ${error}`));
                    logger.error(errmsg, error);
                });

            if (credentials.password) {
                this.authenticatedUser = true;
            }
            if (this.connection && this.connection.connected
                && Strophe.getResourceFromJid(this.connection.jid)) {
                // .connected is true while connecting?
                // this.connection.send($pres());
                this.eventEmitter.emit(
                    JitsiConnectionEvents.CONNECTION_ESTABLISHED,
                    Strophe.getResourceFromJid(this.connection.jid));
            }
        } else if (status === Strophe.Status.CONNFAIL) {
            if (msg === 'x-strophe-bad-non-anon-jid') {
                this.anonymousConnectionFailed = true;
            } else {
                this.connectionFailed = true;
            }
            this.lastErrorMsg = msg;
            if (msg === 'giving-up') {
                this.eventEmitter.emit(
                    JitsiConnectionEvents.CONNECTION_FAILED,
                    JitsiConnectionErrors.OTHER_ERROR, msg);
            }
        } else if (status === Strophe.Status.DISCONNECTED) {
            // Stop ping interval
            this.connection.ping.stopInterval();
            const wasIntentionalDisconnect = this.disconnectInProgress;
            const errMsg = msg || this.lastErrorMsg;

            this.disconnectInProgress = false;
            if (this.anonymousConnectionFailed) {
                // prompt user for username and password
                this.eventEmitter.emit(
                    JitsiConnectionEvents.CONNECTION_FAILED,
                    JitsiConnectionErrors.PASSWORD_REQUIRED);
            } else if (this.connectionFailed) {
                this.eventEmitter.emit(
                    JitsiConnectionEvents.CONNECTION_FAILED,
                    JitsiConnectionErrors.OTHER_ERROR,
                    errMsg,
                    undefined, /* credentials */
                    this._getConnectionFailedReasonDetails());
            } else if (wasIntentionalDisconnect) {
                this.eventEmitter.emit(
                    JitsiConnectionEvents.CONNECTION_DISCONNECTED, errMsg);
            } else {
                // XXX if Strophe drops the connection while not being asked to,
                // it means that most likely some serious error has occurred.
                // One currently known case is when a BOSH request fails for
                // more than 4 times. The connection is dropped without
                // supplying a reason(error message/event) through the API.
                logger.error('XMPP connection dropped!');

                // XXX if the last request error is within 5xx range it means it
                // was a server failure
                const lastErrorStatus = Strophe.getLastErrorStatus();

                if (lastErrorStatus >= 500 && lastErrorStatus < 600) {
                    this.eventEmitter.emit(
                        JitsiConnectionEvents.CONNECTION_FAILED,
                        JitsiConnectionErrors.SERVER_ERROR,
                        errMsg || 'server-error',
                        /* credentials */ undefined,
                        this._getConnectionFailedReasonDetails());
                } else {
                    this.eventEmitter.emit(
                        JitsiConnectionEvents.CONNECTION_FAILED,
                        JitsiConnectionErrors.CONNECTION_DROPPED_ERROR,
                        errMsg || 'connection-dropped-error',
                        /* credentials */ undefined,
                        this._getConnectionFailedReasonDetails());
                }
            }
        } else if (status === Strophe.Status.AUTHFAIL) {
            // wrong password or username, prompt user
            this.eventEmitter.emit(
                JitsiConnectionEvents.CONNECTION_FAILED,
                JitsiConnectionErrors.PASSWORD_REQUIRED,
                msg,
                credentials);
        }
    }

    /**
     *
     * @param jid
     * @param password
     */
    _connect(jid, password) {
        // connection.connect() starts the connection process.
        //
        // As the connection process proceeds, the user supplied callback will
        // be triggered multiple times with status updates. The callback should
        // take two arguments - the status code and the error condition.
        //
        // The status code will be one of the values in the Strophe.Status
        // constants. The error condition will be one of the conditions defined
        // in RFC 3920 or the condition ‘strophe-parsererror’.
        //
        // The Parameters wait, hold and route are optional and only relevant
        // for BOSH connections. Please see XEP 124 for a more detailed
        // explanation of the optional parameters.
        //
        // Connection status constants for use by the connection handler
        // callback.
        //
        //  Status.ERROR - An error has occurred (websockets specific)
        //  Status.CONNECTING - The connection is currently being made
        //  Status.CONNFAIL - The connection attempt failed
        //  Status.AUTHENTICATING - The connection is authenticating
        //  Status.AUTHFAIL - The authentication attempt failed
        //  Status.CONNECTED - The connection has succeeded
        //  Status.DISCONNECTED - The connection has been terminated
        //  Status.DISCONNECTING - The connection is currently being terminated
        //  Status.ATTACHED - The connection has been attached

        this.anonymousConnectionFailed = false;
        this.connectionFailed = false;
        this.lastErrorMsg = undefined;
        this.connection.connect(
            jid,
            password,
            this.connectionHandler.bind(this, {
                jid,
                password
            }));
    }

    /**
     * Attach to existing connection. Can be used for optimizations. For
     * example: if the connection is created on the server we can attach to it
     * and start using it.
     *
     * @param options {object} connecting options - rid, sid, jid and password.
     */
    attach(options) {
        const now = this.connectionTimes.attaching = window.performance.now();

        logger.log(`(TIME) Strophe Attaching\t:${now}`);
        this.connection.attach(options.jid, options.sid,
            parseInt(options.rid, 10) + 1,
            this.connectionHandler.bind(this, {
                jid: options.jid,
                password: options.password
            }));
    }

    /**
     *
     * @param jid
     * @param password
     */
    connect(jid, password) {
        if (!jid) {
            const { anonymousdomain, domain } = this.options.hosts;
            let configDomain = anonymousdomain || domain;

            // Force authenticated domain if room is appended with '?login=true'
            // or if we're joining with the token

            // FIXME Do not rely on window.location because (1) React Native
            // does not have a window.location by default and (2) here we cannot
            // know for sure that query/search has not be stripped from
            // window.location by the time the following executes.
            const { location } = window;

            if (anonymousdomain) {
                const search = location && location.search;

                if ((search && search.indexOf('login=true') !== -1)
                        || this.token) {
                    configDomain = domain;
                }
            }

            // eslint-disable-next-line no-param-reassign
            jid = configDomain || (location && location.hostname);
        }

        return this._connect(jid, password);
    }

    /**
     * Joins or creates a muc with the provided jid, created from the passed
     * in room name and muc host and onCreateResource result.
     *
     * @param {string} roomName - The name of the muc to join.
     * @param {Object} options - Configuration for how to join the muc.
     * @param {Function} [onCreateResource] - Callback to invoke when a resource
     * is to be added to the jid.
     * @returns {Promise} Resolves with an instance of a strophe muc.
     */
    createRoom(roomName, options, onCreateResource) {
        let roomjid = `${roomName}@${this.options.hosts.muc}/`;

        const mucNickname = onCreateResource
            ? onCreateResource(this.connection.jid, this.authenticatedUser)
            : RandomUtil.randomHexString(8).toLowerCase();

        logger.info(`JID ${this.connection.jid} using MUC nickname ${mucNickname}`);
        roomjid += mucNickname;

        return this.connection.emuc.createRoom(roomjid, null, options);
    }

    /**
     * Returns the jid of the participant associated with the Strophe connection.
     *
     * @returns {string} The jid of the participant.
     */
    getJid() {
        return this.connection.jid;
    }

    /**
     * Returns the logs from strophe.jingle.
     * @returns {Object}
     */
    getJingleLog() {
        const jingle = this.connection.jingle;


        return jingle ? jingle.getLog() : {};
    }

    /**
     * Returns the logs from strophe.
     */
    getXmppLog() {
        return (this.connection.logger || {}).log || null;
    }

    /**
     *
     */
    dial(...args) {
        this.connection.rayo.dial(...args);
    }

    /**
     * Pings the server. Remember to check {@link isPingSupported} before using
     * this method.
     * @param timeout how many ms before a timeout should occur.
     * @returns {Promise} resolved on ping success and reject on an error or
     * a timeout.
     */
    ping(timeout) {
        return new Promise((resolve, reject) => {
            if (this.isPingSupported()) {
                this.connection.ping
                    .ping(this.connection.domain, resolve, reject, timeout);
            } else {
                reject('PING operation is not supported by the server');
            }
        });
    }

    /**
     *
     */
    getSessions() {
        return this.connection.jingle.sessions;
    }

    /**
     * Disconnects this from the XMPP server (if this is connected).
     *
     * @param {Object} ev - Optionally, the event which triggered the necessity to
     * disconnect from the XMPP server (e.g. beforeunload, unload).
     * @returns {Promise} - Resolves when the disconnect process is finished or rejects with an error.
     */
    disconnect(ev) {
        if (this.disconnectInProgress || !this.connection) {
            this.eventEmitter.emit(JitsiConnectionEvents.WRONG_STATE);

            return Promise.reject(new Error('Wrong connection state!'));
        }

        this.disconnectInProgress = true;

        return new Promise(resolve => {
            const disconnectListener = (credentials, status) => {
                if (status === Strophe.Status.DISCONNECTED) {
                    resolve();
                    this.eventEmitter.removeListener(XMPPEvents.CONNECTION_STATUS_CHANGED, disconnectListener);
                }
            };

            this.eventEmitter.on(XMPPEvents.CONNECTION_STATUS_CHANGED, disconnectListener);

            // XXX Strophe is asynchronously sending by default. Unfortunately, that
            // means that there may not be enough time to send an unavailable
            // presence or disconnect at all. Switching Strophe to synchronous
            // sending is not much of an option because it may lead to a noticeable
            // delay in navigating away from the current location. As a compromise,
            // we will try to increase the chances of sending an unavailable
            // presence and/or disconecting within the short time span that we have
            // upon unloading by invoking flush() on the connection. We flush() once
            // before disconnect() in order to attemtp to have its unavailable
            // presence at the top of the send queue. We flush() once more after
            // disconnect() in order to attempt to have its unavailable presence
            // sent as soon as possible.
            this.connection.flush();

            if (ev !== null && typeof ev !== 'undefined') {
                const evType = ev.type;

                if (evType === 'beforeunload' || evType === 'unload') {
                    // XXX Whatever we said above, synchronous sending is the best
                    // (known) way to properly disconnect from the XMPP server.
                    // Consequently, it may be fine to have the source code and
                    // comment it in or out depending on whether we want to run with
                    // it for some time.
                    this.connection.options.sync = true;

                    // This is needed in some browsers where sync xhr sending
                    // is disabled by default on unload
                    if (navigator.sendBeacon) {
                        const body = this.connection._proto._buildBody()
                            .attrs({
                                type: 'terminate'
                            });
                        const pres = $pres({
                            xmlns: Strophe.NS.CLIENT,
                            type: 'unavailable'
                        });

                        body.cnode(pres.tree());

                        const res = navigator.sendBeacon(
                            `https${this.connection.service}`,
                            Strophe.serialize(body.tree()));

                        logger.info(`Successfully send unavailable beacon ${res}`);
                    }
                }
            }

            this.connection.disconnect();

            if (this.connection.options.sync !== true) {
                this.connection.flush();
            }
        });
    }

    /**
     *
     */
    _initStrophePlugins() {
        const iceConfig = {
            jvb: { iceServers: [ ] },
            p2p: { iceServers: [ ] }
        };

        const p2pStunServers = (this.options.p2p
            && this.options.p2p.stunServers) || DEFAULT_STUN_SERVERS;

        if (Array.isArray(p2pStunServers)) {
            logger.info('P2P STUN servers: ', p2pStunServers);
            iceConfig.p2p.iceServers = p2pStunServers;
        }

        if (this.options.p2p && this.options.p2p.iceTransportPolicy) {
            logger.info('P2P ICE transport policy: ',
                this.options.p2p.iceTransportPolicy);

            iceConfig.p2p.iceTransportPolicy
                = this.options.p2p.iceTransportPolicy;
        }

        initEmuc(this);
        initJingle(this, this.eventEmitter, iceConfig);
        initStropheUtil();
        initPing(this);
        initRayo();
        initStropheLogger();
    }

    /**
     * Returns details about connection failure. Shard change or is it after
     * suspend.
     * @returns {object} contains details about a connection failure.
     * @private
     */
    _getConnectionFailedReasonDetails() {
        const details = {};

        // check for moving between shard if information is available
        if (this.options.deploymentInfo
            && this.options.deploymentInfo.shard
            && this.connection._proto
            && this.connection._proto.lastResponseHeaders) {

            // split headers by line
            const headersArr = this.connection._proto.lastResponseHeaders
                .trim().split(/[\r\n]+/);
            const headers = {};

            headersArr.forEach(line => {
                const parts = line.split(': ');
                const header = parts.shift();
                const value = parts.join(': ');

                headers[header] = value;
            });

            /* eslint-disable camelcase */
            details.shard_changed
                = this.options.deploymentInfo.shard
                    !== headers['x-jitsi-shard'];
            /* eslint-enable camelcase */
        }

        /* eslint-disable camelcase */
        // check for possible suspend
        details.suspend_time = this.connection.ping.getPingSuspendTime();
        details.time_since_last_success = this._lastSuccessTracker.getTimeSinceLastSuccess();
        /* eslint-enable camelcase */

        return details;
    }

    /**
     * Notifies speaker stats component if available that we are the new
     * dominant speaker in the conference.
     * @param {String} roomJid - The room jid where the speaker event occurred.
     */
    sendDominantSpeakerEvent(roomJid) {
        // no speaker stats component advertised
        if (!this.speakerStatsComponentAddress || !roomJid) {
            return;
        }

        const msg = $msg({ to: this.speakerStatsComponentAddress });

        msg.c('speakerstats', {
            xmlns: 'http://jitsi.org/jitmeet',
            room: roomJid })
            .up();

        this.connection.send(msg);
    }

    /**
     * Check if the given argument is a valid JSON ENDPOINT_MESSAGE string by
     * parsing it and checking if it has a field called 'type'.
     *
     * @param {string} jsonString check if this string is a valid json string
     * and contains the special structure.
     * @returns {boolean, object} if given object is a valid JSON string, return
     * the json object. Otherwise, returns false.
     */
    tryParseJSONAndVerify(jsonString) {
        try {
            const json = JSON.parse(jsonString);

            // Handle non-exception-throwing cases:
            // Neither JSON.parse(false) or JSON.parse(1234) throw errors,
            // hence the type-checking,
            // but... JSON.parse(null) returns null, and
            // typeof null === "object",
            // so we must check for that, too.
            // Thankfully, null is falsey, so this suffices:
            if (json && typeof json === 'object') {
                const type = json[JITSI_MEET_MUC_TYPE];

                if (typeof type !== 'undefined') {
                    return json;
                }

                logger.debug('parsing valid json but does not have correct '
                    + 'structure', 'topic: ', type);
            }
        } catch (e) {
            return false;
        }

        return false;
    }

    /**
     * A private message is received, message that is not addressed to the muc.
     * We expect private message coming from speaker stats component if it is
     * enabled and running.
     *
     * @param {string} msg - The message.
     */
    _onPrivateMessage(msg) {
        const from = msg.getAttribute('from');

        if (!this.speakerStatsComponentAddress
            || from !== this.speakerStatsComponentAddress) {
            return;
        }

        const jsonMessage = $(msg).find('>json-message')
            .text();
        const parsedJson = this.tryParseJSONAndVerify(jsonMessage);

        if (parsedJson
            && parsedJson[JITSI_MEET_MUC_TYPE] === 'speakerstats'
            && parsedJson.users) {
            this.eventEmitter.emit(
                XMPPEvents.SPEAKER_STATS_RECEIVED, parsedJson.users);
        }

        return true;
    }
}

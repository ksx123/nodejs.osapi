/**
 * osapi/swift offers interfaces which are compitable with OpenStack Swift (OpenStack Object Storage).
 * For more details, please see
 * 
 *   OpenStack Documentation, Object Storage API Reference 2.15.2
 *   https://developer.openstack.org/api-ref-objectstorage-v1.html
 *   https://developer.openstack.org/api-ref/object-store/index.html
 * 
 *   OpenStack API Documentation
 *   https://developer.openstack.org/api-guide/quick-start/api-quick-start.html
 *   
 *   CEPH OBJECT GATEWAY SWIFT API
 *   http://docs.ceph.com/docs/master/radosgw/swift/
 *
 * @author youngoat@163.com
 */

/**
 * -- COMMON RULES --
 * All methods named as "find*", "create*", "put*" or "delete*" are asynchronous. When 
 * callback provided, the method will return undefined. If no callback provided, 
 * the method will return an instance of Promise.
 */

'use strict';

const MODULE_REQUIRE = 1
	/* built-in */
	, crypto = require('crypto')
	, events = require('events')
	, querystring = require('querystring')
	, stream = require('stream')
	, url = require('url')
	, util = require('util')

	/* NPM */
	, htp = require('htp')
	, if2 = require('if2')
	, noda = require('noda')
	, SimpleAgent = require('htp/SimpleAgent')
	
	// Jin-nang tools.
	, cloneObject = require('jinang/cloneObject')
	, modifyUrl = require('jinang/modifyUrl')
	, parseOptions = require('jinang/parseOptions')
		
	/* in-package */
	, Receiver = noda.inRequire('lib/Receiver')
	, setIfHasNot = noda.inRequire('lib/setIfHasNot')
	
	// Customized errors.
	, RequestRefusedError = noda.inRequire('class/RequestRefusedError')
	, OptionsAbsentError = noda.inRequire('class/OptionAbsentError')

	/* in-file */
	, encodeAndAppendQuery = (urlname, options, queryNames) => {
		urlname = urlname.split('/').map(encodeURIComponent).join('/');

		if (options) {
			let querys = queryNames ? cloneObject(options, queryNames) : options;
			let query = querystring.stringify(querys);
			if (query) {
				urlname += `?${query}`;
			}
		}

		return urlname;
	}
	
	// Retrieve object meta information from response.
	, parseObjectMeta = (response) => {
		let def = {
			caseSensitive: false,
			keepNameCase: true,
			explicit: true,
			columns: [
				'contentType alias(content-type)',
				'contentLength alias(content-length)',
				{ name: 'lastModified', alias: 'last-modified', parser: t => new Date(t) },
			],
		};
		return parseOptions(response.headers, def);
	}

	, encodeName = (name) => encodeURIComponent(name)
	;

/**
 * Create a new connection to Ceph service.
 * Actually, we will request a new token, rather than to build a chanel between the client and the server.
 * @class
 * 
 * @param  {Object}  options 
 * 
 * @param  {string}  options.endPoint     
 * @param  {string}  options.url           alias of "options.endPoint"
 * 
 * @param  {string} [options.username]
 * @param  {string} [options.subusername]
 * @param  {string} [options.subuser]      alias of "options.username:options.subusername"
 * 
 * @param  {string} [options.key]
 * @param  {string} [options.password]     alias of "options.key"
 * 
 * @param  {string} [options.container]    
 * @param  {string} [options.bucket]       alias of "options.container". Bucket is a concept of Amazon S3, it is known as "container" in OpenStack Swift.
 */
const Connection = function(options) {
	// Clone and uniform the input options.
	options = cloneObject(options, (key, value) => [ key.toLowerCase(), value ]);

	this.container = if2(options.container, options.bucket);
	this.tempURLKey = options.tempurlkey;
	
	this.authToken = null;
	this.storageUrl = null;
	this.storageToken = null;
	this.agent = null;

	// subuser
	// username & subUsername
	var subuser = null;
	if (options.subuser) {
		subuser = options.subuser;
	}
	else if (options.username && options.subusername) {
		subuser = `${options.username}:${options.subusername}`;
	}
	if (!subuser) {
		throw new OptionsAbsentError('subuser', ['username,', 'subusername']);
	}
	[ this.username, this.subUsername ] = subuser.split(':');

	// key
	var key = options.key;
	if (!key) {
		throw new OptionsAbsentError('key');
	}

	// endpoint
	this.endPoint = if2(options.endpoint, options.url);
	if (!this.endPoint) {
		throw new OptionsAbsentError('endPoint');
	}
	
	// ---------------------------
	// Authentication.
	// @see http://docs.ceph.com/docs/master/radosgw/swift/auth/

	if (1) {
		let authurl = modifyUrl.pathname(this.endPoint, '/auth/1.0');
		
		let headers = {
			'X-Auth-User' : subuser,
			'X-Auth-Key'  : key,
		};
		htp.get(authurl, headers, (err, res) => {
			err = err || this._parseResponseError('AUTH', null, [ 204 ], res);
			if (err) return this.emit('error', err), undefined;

			// Optional.
			this.authToken = res.headers['x-auth-token'];
	
			// The URL and {api version}/{account} path for the user.
			// @see http://docs.ceph.com/docs/master/radosgw/swift/auth/
			this.storageUrl = res.headers['x-storage-url'];

			// The authorization token for the X-Auth-User specified in the request.
			// @see http://docs.ceph.com/docs/master/radosgw/swift/auth/
			this.storageToken = res.headers['x-storage-token'];

			let agentOptions = {
				endPoint: this.storageUrl,

				// Query "format" is prior to header "Accept".
				// query: 'format=json',

				headers: { 
					'X-Auth-Token': this.storageToken,

					// Header "Accept" is inferior to query "format".
					'Accept': 'application/json',
				}
			};

			let pipingAgentOptions = Object.assign({}, agentOptions, 
				{ settings: { piping : true, pipingOnly : true } });

			this.agent = new SimpleAgent(agentOptions);
			this.pipingAgent = new SimpleAgent(pipingAgentOptions);

			this.emit('connected');
		});
	}

	this.setMaxListeners(100000);
};

// Inherit class EventEmitter in order to invoke methods .emit(), .on(), .once() etc.
util.inherits(Connection, events.EventEmitter);

/**
 * @param  {Function} action
 * @param  {Function} callback
 * 
 * @example 
 *   Connection.prototype.foo = function(..., callback) {
 *     return this._action((done) => {
 *        // ...
 *        done(err, data);
 *     }, callback);
 *   }
 */
Connection.prototype._action = function(action, callback) {
	let RR = (resolve, reject) => {
		let done = (err, data) => {
			err ? reject && reject(err) : resolve && resolve(data);
			callback && callback(err, data);
		};
		let run = () => action(done);

		if (this.isConnected()) {
			run();
		}
		else {
			this.once('connected', run);
			this.once('error', done);
		}
	};
	return callback ? RR() : new Promise(RR);
};

/**
 * Generate a standard RequestRefusedError by parsing the response from remote storage service.
 * @param {Object}       options
 * @param {string}       options.action
 * @param {Object}       options.meta
 * @param {number[]}     options.expect expected status codes
 * @param {htp.Response} options.response
 */
Connection.prototype._parseResponseError = function(action, meta, expect, response) {
	if (expect.includes(response.statusCode)) {
		return null;
	}
	else {
		let code = response.body && response.body.Code;
		let res = {
			statusCode: response.statusCode,
			statusMessage: response.statusMessage,
			code,
		};
		let err = new RequestRefusedError(action, meta, res);
		return err;
	}
};

/**
 * Create new container(bucket) on remote storage.
 * @param  {Object}           options
 * @param  {string}           options            regard as the name(key) of object to be stored
 * @param  {string}           options.name       name(key) of object to be stored
 * @param  {Function}        [callback]          function(err, data)
 */
Connection.prototype.createContainer = function(options, callback) {
	// ---------------------------
	// Uniform arguments.

	if (typeof options == 'string') {
		options = { name: options };
	}
	else {
		options = Object.assign({}, options);
	}

	return this._action((done) => {
		let urlname = encodeAndAppendQuery(options.name);
		this.agent.put(urlname, '', (err, response) => {
			err = err || this._parseResponseError(
				'CONTAINER_CREATE', 
				cloneObject(options, ['name']),
				[ 201, 202 ],
				response
			);
			let data = err ? null : {
				transId: response.headers['x-trans-id'],
			};
			done(err, data);
		});
	}, callback);
}

/**
 * Put an object to remote storage.
 * @param  {Object}           options
 * @param  {string}           options            regard as the name(key) of object to be stored
 * @param  {string}           options.name       name(key) of object to be stored
 * @param  {string}          [options.container] container/bucket to place the object, 
 *                                               by default current container of the connection will be used
 * @param  {string}           content            object content text
 * @param  {stream.Readable}  content            object content stream
 * @param  {Buffer}           content            object content buffer
 * @param  {Function}        [callback]          function(err, data)
 */
Connection.prototype.createObject = function(options, content, callback) {
	// ---------------------------
	// Uniform arguments.

	if (typeof options == 'string') {
		options = { name: options };
	}
	else {
		options = Object.assign({}, options);
	}
	
	// Use property of current connection as default.
	setIfHasNot(options, 'container', this.container);

	return this._action((done) => {
		let urlname = encodeAndAppendQuery(`${options.container}/${options.name}`);

		let headers = parseOptions(options, {
			caseSensitive: false,
			explicit: true,
			columns: [
				'content-type alias(contentType)',
			]
		});

		this.agent.put(urlname, headers, content, (err, response) => {
			err = err || this._parseResponseError('OBJECT_CREATE', { name: options.name }, [ 201 ], response);
			if (err) {
				done(err, null);
			}
			else {
				done(null, {
					transId: response.headers['x-trans-id'],
					etag: response.headers['etag']
				});
			}
		});
	}, callback);
};

/**
 * @param  {Object}           options
 * @param  {string}           options              regard as options.name
 * @param  {string}          [options.name]        container name
 * @param  {Function}        [callback]
 */
Connection.prototype.deleteContainer = function(options, callback) {
	// ---------------------------
	// Uniform arguments.
	
	if (typeof options == 'string') {
		options = { name: options };
	}
	else {
		options = Object.assign({}, options);
	}
	
	return this._action((done) => {
		let urlname = encodeAndAppendQuery(`${options.name}`);
		this.agent.delete(urlname, (err, response) => {
			err = err || this._parseResponseError(
				'CONTAINER_DELETE', 
				cloneObject(options, ['name']),
				[ 204 ],
				response
			);
			done(err);
		});
	}, callback);
};

/**
 * @param  {Object}           options
 * @param  {string}           options              regard as options.name
 * @param  {string}          [options.container]   container name
 * @param  {string}          [options.name]        name(key) of object
 * @param  {Function}        [callback]
 */
Connection.prototype.deleteObject = function(options, callback) {
	// ---------------------------
	// Uniform arguments.
	
	if (typeof options == 'string') {
		options = { name: options };
	}
	else {
		options = Object.assign({}, options);
	}
	
	// Use property of current connection as default.
	setIfHasNot(options, 'container', this.container);
	
	return this._action((done) => {
		let urlname = encodeAndAppendQuery(`${options.container}/${options.name}`);
		this.agent.delete(urlname, (err, response) => {
			err = err || this._parseResponseError(
				'OBJECT_DELETE', 
				cloneObject(options, ['container', 'name']),
				[ 204 ],
				response
			);
			done(err);
		});
	}, callback);
};

/**
 * @param  {Object}   [options]
 * @param  {number}   [options.limit]   return top n(limit) containers
 * @param  {string}   [options.marker]  name of container where cursor on
 * @param  {Function} [callback]
 */
Connection.prototype.findContainers = function(options, callback) {
	// ---------------------------
	// Uniform arguments.

	if (typeof arguments[0] == 'function') {
		options = {};
		callback = arguments[0];
	}

	if (!options) {
		options = {};
	}

	return this._action((done) => {
		let urlname = encodeAndAppendQuery('/', options, [ 'limit', 'marker' ]);
		this.agent.get(urlname, (err, response) => {
			if (err) return done(err);
			
			// ...
			done(null, response.body);
		});
	}, callback);
};

/**
 * Find some objects from remote storage.
 * @param  {Object}           options
 * @param  {string}           options              regarded as options.prefix
 * @param  {string}          [options.container]   container name
 * @param  {char}            [options.delimiter]   path delimiter, READMORE for details
 * @param  {string}          [options.marker]      name of object reached in last time
 * @param  {string}          [options.prefix]      prefix of name(key) of objects
 * @param  {string}          [options.path]        leading path
 * @param  {number}          [options.limit]       maximum number of returned objects.
 *                                                 By default, up to 10,000 will be returned. 
 *                                                 The maximum value is configurable for server admin.
 * @param  {Function}        [callback]
 * 
 * -- READMORE：path and delimiter --
 * name(key) of objects are also regarded as path. And options.delimiter is 
 * used to suppose path delimiter as we are fimilar with path.
 * 
 * Suppose that following object names(keys) exist,
 *   [1] foo
 *   [2] foo/bar/0
 *   [3] foo/bar/1
 * When options.delimiter absent, all objects matched.
 * When options.delimiter set to '/', it will return
 *   { name: 'foo' }
 *   { subir: 'foo/' }
 * 
 * -- READMORE: path vs. prefix --
 * Suppose that following object names(keys) exist,
 *   [1] foo/bar/0
 *   [2] foo/quz/1
 * options.path "foo/bar" matches [1]
 * options.path "foo" matches [1][2]
 * options.path "fo" matches NONE
 * options.prefix "fo" matches [1][2]
 * 
 * -- READMORE: should name prefixed with / ? --
 * 
 */
Connection.prototype.findObjects = function(options, callback) {
	// ---------------------------
	// Uniform arguments.

	if (typeof options == 'string') {
		options = { prefix: options };
	}
	else {
		options = Object.assign({}, options);
	}

	// Use property of current connection as default.
	setIfHasNot(options, 'container', this.container);
	
	return this._action((done) => {
		let urlname = encodeAndAppendQuery(`${options.container}`, options, [ 'delimiter', 'limit', 'path', 'prefix', 'marker' ]);
		this.agent.get(urlname, (err, response) => {
			err = err || this._parseResponseError(
				'OBJECT_FIND', 
				cloneObject(options, [ 'container' ]),
				[ 200, 204 ],
				response
			);
			
			let data = err ? null : response.body;
			done(err, data);
		});
	}, callback);
};

/**
 * @param  {Object}           options
 * @param  {string}           options           regard as the name(key) of object to be stored
 * @param  {string}           options.name      name(key) of object to be stored
 * @param  {number}           options.ttl       time to live (in seconds)
 * @param  {string}           options.container container/bucket to place the object
 * @return {string}
 * 
 * -- REFERENCES --
 * https://docs.openstack.org/kilo/config-reference/content/object-storage-tempurl.html
 */
Connection.prototype.generateTempUrl = function(options, callback) {
	// ---------------------------
	// Uniform arguments.

	if (typeof options == 'string') {
		options = { name: options };
	}
	else {
		options = Object.assign({}, options);
	}

	// Use property of current connection as default.
	setIfHasNot(options, 'container', this.container);

	// Default ttl is 24 hours.
	setIfHasNot(options, 'ttl', 86400);
	
	return this._action((done) => {
		let urlname = encodeAndAppendQuery(`${this.storageUrl}/${options.container}/${options.name}`);
		let temp_url_expires = parseInt(Date.now() / 1000) + options.ttl;
		let temp_url_sig;
	
		// Genereate temp_url_sig.
		if (1) {
			let method = 'GET';
			let pathname = `/v1/${options.container}/${options.name}`;
			let body = [ method, temp_url_expires, pathname ].join('\n');

			// Generate an HMAC (Hash-based Message Authentication Code) using a SHA-1 hashing algorithm. 
			// See RFC 2104 and HMAC for details.
			let hmac = crypto.createHmac('sha1', this.tempURLKey);
			hmac.update(body, 'utf8');
			temp_url_sig = hmac.digest('hex');
		}
		
		let temp_url = `${urlname}?${querystring.stringify({ temp_url_sig, temp_url_expires })}`;
		done(null, temp_url);
	}, callback);
};

Connection.prototype.get = function(name) {
	switch (name.toLowerCase()) {
		case 'style'       : return 'swift';
		case 'endpoint'    : return this.endPoint;
		case 'username'    : return this.username;
		case 'subusername' : return this.subUsername;
		case 'subuser'     : return this.subuser;
		case 'container'   : return this.container;
	}
};

/**
 * To learn whether connection created successfully.
 * @return {boolean} true if connected
 */
Connection.prototype.isConnected = function() {
	return !!this.authToken;
};

/**
 * Retrieve an object from remote storage.
 * @param  {Object}           options
 * @param  {string}           options              regard as options.name
 * @param  {string}          [options.container]   container name
 * @param  {string}          [options.name]        name(key) of object
 * @param  {Function}        [callback]
 */
Connection.prototype.readObject = function(options, callback) {
	// ---------------------------
	// Uniform arguments.
	
	if (typeof options == 'string') {
		options = { name: options };
	}
	else {
		options = Object.assign({}, options);
	}
	
	// Use property of current connection as default.
	if (!options.hasOwnProperty('container')) {
		options.container = this.container;
	}
	
	return this._action((done) => {
		let urlname = encodeAndAppendQuery(`${options.container}/${options.name}`, options, []);
		this.agent.get(urlname, (err, response) => {
			err = err || this._parseResponseError(
				'OBJECT_GET', 
				cloneObject(options, [ 'name' ]),
				[ 200 ],
				response
			);
			let data = err ? null : Object.assign(
				parseObjectMeta(response), 
				{ buffer: response.bodyBuffer }
			);
			done(err, data);
		});
	}, callback);
};

/**
 * Retrieve an object from remote storage.
 * @param  {Object}           options
 * @param  {string}           options              regard as options.name
 * @param  {string}          [options.container]   container name
 * @param  {string}          [options.name]        name(key) of object
 * @param  {Function}        [callback]
 * @return {stream.Readable}
 */
Connection.prototype.pullObject = function(options, callback) {
	// ---------------------------
	// Uniform arguments.
	
	if (typeof options == 'string') {
		options = { name: options };
	}
	else {
		options = Object.assign({}, options);
	}
	
	// Use property of current connection as default.
	if (!options.hasOwnProperty('container')) {
		options.container = this.container;
	}

	let urlname = encodeAndAppendQuery(`${options.container}/${options.name}`, options, []);
	let output = new Receiver();
	let onCall = (err, meta) => {
		if (err) {
			output.emit('error', err);
		}
		callback && callback(err, meta);
	};

	let meta = null;
	this._action((done) => {
		this.pipingAgent.get(urlname)
			.on('error', done)
			.on('response', (response) => {
				let err = this._parseResponseError(
					'OBJECT_GET',
					cloneObject(options, [ 'name' ]),
					[ 200 ],
					response
				);
				if (err) {
					done(err);
				}
				else {
					meta = parseObjectMeta(response);
					output.emit('meta', meta);
				}
			})
			.on('end', () => {
				done(null, meta);
			})
			.pipe(output)
			;
	}, onCall);
	return output;
};

module.exports = {
	Connection
};

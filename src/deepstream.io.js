var ConnectionEndpoint = require( './message/connection-endpoint' ),
	MessageProcessor = require( './message/message-processor' ),
	MessageDistributor = require( './message/message-distributor' ),
	EventHandler = require( './event/event-handler' ),
	EventEmitter = require( 'events' ).EventEmitter,
	messageParser = require( './message/message-parser' ),
	readMessage = require( './utils/read-message' ),
	util = require( 'util' ),
	utils = require( './utils/utils' ),
	defaultOptions = require( './default-options' ),
	RpcHandler = require( './rpc/rpc-handler' ),
	RecordHandler = require( './record/record-handler' ),
	DependencyInitialiser = require( './utils/dependency-initialiser' ),
	C = require( './constants/constants' );

require( 'colors' );

/**
 * Deepstream is a realtime data server that scales horizontally
 * by running in clusters of interacting nodes
 *
 * @copyright 2015 Hoxton-One Ltd.
 * @author Wolfram Hempel
 * @version <version>
 *
 * @constructor
 */
var Deepstream = function() {
	this.isRunning = false;
	this.constants = C;
	this._options = defaultOptions.get();
	this._connectionEndpoint = null;
	this._engineIo = null;
	this._messageProcessor = null;
	this._messageDistributor = null;
	this._eventHandler = null;
	this._rpcHandler = null;
	this._recordHandler = null;
	this._initialised = false;
	this._plugins = [
		'messageConnector',
		'storage',
		'cache',
		'logger'
	];
};

util.inherits( Deepstream, EventEmitter );

/**
 * Sets the name of the process
 *
 * @type {String}
 */
process.title = 'deepstream server';

/**
 * Expose constants to allow consumers to access them without
 * requiring a reference to a deepstream instance.
 *
 *
*/
Deepstream.constants = C;


/**
 * Utility method to return a helper object to simplify permissions assertions
 *
 * @param  {object} message description
 * @return {object}         description
 */
Deepstream.readMessage = readMessage;

/**
 * Set a deepstream option. For a list of all available options
 * please see default-options.
 *
 * @param {String} key   the name of the option
 * @param {Mixed} value  the value, e.g. a portnumber for ports or an instance of a logger class
 *
 * @public
 * @returns {void}
 */
Deepstream.prototype.set = function( key, value ) {
	if( this._options[ key ] === undefined ) {
		throw new Error( 'Unknown option "' + key + '"' );
	}

	this._options[ key ] = value;
};

/**
 * Starts up deepstream. The startup process has three steps:
 *
 * - Initialise all dependencies (cache connector, message connector, storage connector and logger)
 * - Instantiate the messaging pipeline and record-, rpc- and event-handler
 * - Start TCP and HTTP server
 *
 * @public
 * @returns {void}
 */
Deepstream.prototype.start = function() {
	this._showStartLogo();

	if( this._options.logger.isReady ) {
		this._options.logger.setLogLevel( this._options.logLevel );
		this._options.logger._$useColors = this._options.colors;
	}


	var i,
		initialiser;

	for( i = 0; i < this._plugins.length; i++ ) {
		initialiser = new DependencyInitialiser( this._options, this._plugins[ i ] );
		initialiser.once( 'ready', this._checkReady.bind( this, this._plugins[ i ], initialiser.getDependency() ));
	}
};

/**
 * Stops the server and closes all connections. The server can be started again,
 * but all clients have to reconnect. Will emit a 'stopped' event once done
 *
 * @public
 * @returns {void}
 */
Deepstream.prototype.stop = function() {
	var i,
		plugin,
		closables = [ this._connectionEndpoint ];

	for( i = 0; i < this._plugins.length; i++ ) {
		plugin = this._options[ this._plugins[ i ] ];
		if( typeof plugin.close === 'function' ) {
			closables.push( plugin );
			setTimeout( plugin.close.bind( plugin ) );
		}
	}

	this._initialised = false;
	utils.combineEvents( closables, 'close', this._onStopped.bind( this ) );
	this._connectionEndpoint.close();
};

/**
 * Expose the message-parser's convertTyped method
 * so that it can be used within permissionHandlers
 *
 * @param   {String} value A String starting with a type identifier (see C.TYPES)
 *
 * @public
 * @returns {mixed} the converted value
 */
Deepstream.prototype.convertTyped = function( value ) {
	return messageParser.convertTyped( value );
};

/**
 * Callback for the final stop event
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype._onStopped = function() {
	this.isRunning = false;
	this.emit( 'stopped' );
};

/**
 * Shows a giant ASCII art logo which is absolutely crucial
 * for the proper functioning of the server
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype._showStartLogo = function() {
	if( this._options.showLogo !== true ) {
		return;
	}

	var logo =
	' _____________________________________________________________________________\n'+
	'                                                                              \n'+
	'         /                                                             ,      \n'+
	' ----__-/----__----__------__---__--_/_---)__----__----__---_--_-----------__-\n'+
	'   /   /   /___) /___)   /   ) (_ ` /    /   ) /___) /   ) / /  )    /   /   )\n'+
	' _(___/___(___ _(___ ___/___/_(__)_(_ __/_____(___ _(___(_/_/__/__o_/___(___/_\n'+
	'                       /                                                      \n'+
	'                      /                                                       \n'+
	'=============================== STARTING... ==================================\n';

	process.stdout.write( this._options.colors ? logo.yellow : logo );
};

/**
 * Invoked once all dependencies are initialised. Instantiates the messaging pipeline and the various handlers.
 * The startup sequence will be complete once the connection endpoint is started and listening
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype._init = function() {
	this._connectionEndpoint = new ConnectionEndpoint( this._options, this._onStarted.bind( this ) );
	this._messageProcessor = new MessageProcessor( this._options );
	this._messageDistributor = new MessageDistributor( this._options );
	this._connectionEndpoint.onMessage = this._messageProcessor.process.bind( this._messageProcessor );

	this._eventHandler = new EventHandler( this._options );
	this._messageDistributor.registerForTopic( C.TOPIC.EVENT, this._eventHandler.handle.bind( this._eventHandler ) );

	this._rpcHandler = new RpcHandler( this._options );
	this._messageDistributor.registerForTopic( C.TOPIC.RPC, this._rpcHandler.handle.bind( this._rpcHandler ) );

	this._recordHandler = new RecordHandler( this._options );
	this._messageDistributor.registerForTopic( C.TOPIC.RECORD, this._recordHandler.handle.bind( this._recordHandler ) );

	this._messageProcessor.onAuthenticatedMessage = this._messageDistributor.distribute.bind( this._messageDistributor );

	this._initialised = true;
};

/**
 * Called whenever a dependency emits a ready event. Once all dependencies are ready
 * deepstream moves to the init step.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype._checkReady = function( pluginName, plugin ) {
	if( plugin instanceof EventEmitter ) {
		plugin.on( 'error', this._onPluginError.bind( this, pluginName ) );
	}

	for( var i = 0; i < this._plugins.length; i++ ) {
		if( this._options[ this._plugins[ i ] ].isReady !== true ) {
			return;
		}
	}

	if( this._initialised === false ) {
		this._init();
	}
};

/**
 * Final callback - Deepstream is up and running now
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype._onStarted = function() {
	this._options.logger.log( C.LOG_LEVEL.INFO, C.EVENT.INFO, 'Deepstream started' );
	this.isRunning = true;
	this.emit( 'started' );
};

/**
 * Callback for plugin errors that occur at runtime. Errors during initialisation
 * are handled by the DependencyInitialiser
 *
 * @param   {String} pluginName
 * @param   {Error} error
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype._onPluginError = function( pluginName, error  ) {
	var msg = 'Error from ' + pluginName + ' plugin: ' + error.toString();
	this._options.logger.log( C.LOG_LEVEL.ERROR, C.EVENT.PLUGIN_ERROR, msg );
};

module.exports = Deepstream;

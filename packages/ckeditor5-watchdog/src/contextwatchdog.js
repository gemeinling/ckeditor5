/**
 * @license Copyright (c) 2003-2020, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */

/**
 * @module watchdog/contextwatchdog
 */

/* globals console */

import Watchdog from './watchdog';
import EditorWatchdog from './editorwatchdog';
import areConnectedThroughProperties from './utils/areconnectedthroughproperties';
import getSubNodes from './utils/getsubnodes';

/**
 * The Context Watchdog class.
 */
export default class ContextWatchdog extends Watchdog {
	/**
	 * @param {Object} [contextConfig] Context configuration.
	 * @param {module:watchdog/watchdog~WatchdogConfig} [watchdogConfig] The watchdog plugin configuration.
	 */
	constructor( contextConfig = {}, watchdogConfig = {} ) {
		super( watchdogConfig );

		/**
		 * @protected
		 * @type {Map.<string,module:watchdog/watchdog~EditorWatchdog>}
		 */
		this._watchdogs = new Map();

		/**
		 * @private
		 * @type {module:core/context~Context|null}
		 */
		this._context = null;

		/**
		 * @private
		 * @type {Set.<*>}
		 */
		this._contextProps = new Set();

		/**
		 * @private
		 * @type {ActionQueue}
		 */
		this._actionQueue = new ActionQueue();

		/**
		 * @private
		 * @type {Object}
		 */
		this._contextConfig = contextConfig;

		/**
		 * The context configuration.
		 *
		 * @private
		 * @member {Object|undefined} #_config
		 */

		this._destructor = context => context.destroy();

		this._actionQueue.onEmpty( () => {
			if ( this.state !== 'destroyed' ) {
				this.state = 'ready';
			}
		} );
	}

	/**
	 * The context instance. Keep in mind that this property might be changed when the ContextWatchdog restarts,
	 * so do not keep this instance internally. Always operate on the `contextWatchdog.context` property.
	 *
	 * @type {module:core/context~Context|null}
	 */
	get context() {
		return this._context;
	}

	/**
	 * Returns the watchdog for the added item by its name.
	 *
	 * @param {String} name The watchdog name (the key under which the watchdog config was passed to the add() method).
	 */
	getWatchdog( name ) {
		return this._watchdogs.get( name );
	}

	/**
	 * Adds items to the watchdog. Internally watchdogs will be created for all of these items and they will be available
	 *
	 *
	 * @param {Array.<Object.<string,module:watchdog/contextwatchdog~WatchdogItemConfiguration>>} itemConfigurations
	 */
	async add( itemConfigurations ) {
		await this._actionQueue.enqueue( async () => {
			if ( this.state === 'destroyed' ) {
				throw new Error( 'Cannot add items to destroyed watchdog.' );
			}

			if ( !this._context ) {
				throw new Error( 'Context was not created yet. You should call the `ContextWatchdog#create()` method first.' );
			}

			// Create new watchdogs.
			await Promise.all( Object.entries( itemConfigurations ).map( async ( [ itemName, item ] ) => {
				let watchdog;

				if ( this._watchdogs.has( itemName ) ) {
					throw new Error( `Watchdog with the given name is already added: '${ itemName }'.` );
				}

				if ( item.type === 'editor' ) {
					// TODO - await EditorWatchdog.createFrom( item, context ) ?
					watchdog = new EditorWatchdog();
					watchdog.setCreator( item.creator );
					watchdog._setExcludedProperties( this._contextProps );

					if ( item.destructor ) {
						watchdog.setDestructor( item.destructor );
					}

					this._watchdogs.set( itemName, watchdog );

					await watchdog.create( item.sourceElementOrData, item.config, this._context );
				} else {
					throw new Error( `Not supported item type: '${ item.type }'.` );
				}
			} ) );
		} );
	}

	/**
	 * TODO
	 *
	 * @param {Array.<String>} itemNames
	 */
	async remove( itemNames ) {
		await this._actionQueue.enqueue( async () => {
			await Promise.all( itemNames.map( async itemName => {
				const watchdog = this._watchdogs.get( itemName );

				this._watchdogs.delete( itemName );

				if ( !watchdog ) {
					throw new Error( `There is no watchdog named: '${ itemName }'.` );
				}

				await watchdog.destroy();
			} ) );
		} );
	}

	/**
	 * Waits for all previous actions.
	 */
	async waitForReady() {
		await this._actionQueue.enqueue( () => { } );
	}

	/**
	 * Creates the Context watchdog.
	 */
	async create() {
		await this._actionQueue.enqueue( async () => {
			await this._create( true );
		} );
	}

	/**
	 * Destroys the `ContextWatchdog` and all added items. This method can't be undone.
	 * Once the `ContextWatchdog` is destroyed new items can not be added.
	 */
	async destroy() {
		await this._actionQueue.enqueue( async () => {
			this.state = 'destroyed';

			await this._destroy( true );
		} );
	}

	/**
	 * Restarts the `ContextWatchdog`.
	 *
	 * @protected
	 */
	async _restart() {
		await this._actionQueue.enqueue( async () => {
			this.state = 'initializing';

			try {
				await this._destroy( true );
			} catch ( err ) {
				console.error( 'An error happened during destructing.', err );
			}

			await this._create( true );

			this.fire( 'restart' );
		} );
	}

	/**
	 * @protected
	 */
	async _create( isInternal = false ) {
		await this._actionQueue.enqueue( async () => {
			this._startErrorHandling();

			this._context = await this._creator( this._contextConfig );
			this._contextProps = getSubNodes( this._context );

			await Promise.all(
				Array.from( this._watchdogs.values() )
					.map( async watchdog => {
						watchdog._setExcludedProperties( this._contextProps );
						await watchdog.create( undefined, undefined, this._context );
					} )
			);
		}, isInternal );
	}

	/**
	 * Destroys the Context and all added items.
	 *
	 * @param {Boolean} isInternal
	 */
	async _destroy( isInternal = false ) {
		await this._actionQueue.enqueue( async () => {
			this._stopErrorHandling();

			const context = this._context;

			this._context = null;
			this._contextProps = new Set();

			await Promise.all(
				Array.from( this._watchdogs.values() )
					.map( async watchdog => watchdog.destroy() )
			);

			// Context destructor destroys each editor.
			await this._destructor( context );
		}, isInternal );
	}

	/**
	 * Checks whether the error comes from the Context and not from Editor or ContextItem instances.
	 *
	 * @param {Error} error
	 */
	_isErrorComingFromThisInstance( error ) {
		for ( const watchdog of this._watchdogs.values() ) {
			if ( watchdog._isErrorComingFromThisInstance( error ) ) {
				return false;
			}
		}

		// Return true only if the error comes directly from the context.
		// Ignore cases when the error comes from editors.
		return areConnectedThroughProperties( this._contextProps, error.context );
	}

	/**
	 *
	 * @param {module:core/context~Context} Context
	 * @param {Object} [contextConfig]
	 * @param {module:watchdog/watchdog~WatchdogConfig} [watchdogConfig]
	 */
	static for( Context, contextConfig, watchdogConfig ) {
		const watchdog = new this( contextConfig, watchdogConfig );

		watchdog.setCreator( config => Context.create( config ) );

		watchdog.create();

		return watchdog;
	}
}

class ActionQueue {
	constructor() {
		/**
		 * @type {Array.<Function>}
		 */
		this._queuedActions = [];

		/**
		 * @type {WeakMap.<Function, Function>}
		 */
		this._resolveCallbacks = new WeakMap();

		/**
		 * @type {Array.<Function>}
		 */
		this._onEmptyCallbacks = [];
	}

	onEmpty( onEmptyCallback ) {
		this._onEmptyCallbacks.push( onEmptyCallback );
	}

	/**
	 * It adds asynchronous actions (functions) to the queue and runs them one by one.
	 * If the `isInternal` option is passed then it runs the provided function immediately.
	 *
	 * @param {Function} action
	 * @param {Boolean} isInternal
	 */
	async enqueue( action, isInternal = false ) {
		// Run all internal callbacks immediately.
		if ( isInternal ) {
			return action();
		}

		this._queuedActions.push( action );

		if ( this._queuedActions.length > 1 ) {
			await new Promise( res => {
				this._resolveCallbacks.set( action, res );
			} );

			return;
		}

		while ( this._queuedActions.length ) {
			const action = this._queuedActions[ 0 ];

			const resolve = this._resolveCallbacks.get( action );

			await action();

			this._queuedActions.shift();

			if ( resolve ) {
				resolve();
			}
		}

		this._onEmptyCallbacks.forEach( cb => cb() );
	}

	/**
	 * @protected
	 *
	 * Clears all queued actions (e.g. in case of an error).
	 */
	clear() {
		this._queuedActions = [];
	}
}

/**
 * The WatchdogItemConfiguration interface
 *
 * @typedef {module:watchdog/contextwatchdog~EditorWatchdogConfiguration} module:watchdog/contextwatchdog~WatchdogItemConfiguration
 */

/**
 * The EditorWatchdogConfiguration interface specifies how editors should be created and destroyed.
 *
 * @typedef {Object} module:watchdog/contextwatchdog~EditorWatchdogConfiguration
 *
 * @property {Function} creator A function that needs to be called to initialize the editor.
 *
 * @property {Function} [destructor] A function that is responsible for destructing the editor.
 *
 * @property {String|HTMLElement} sourceElementOrData The source element or data which will be passed
 * as the first argument to the `Editor.create()` method.
 *
 * @property {any} config An editor configuration.
 */

(function (App) {
	'use strict';

	var STREAM_PORT = 21584; // 'PT'!
	var BUFFERING_SIZE = 10 * 1024 * 1024;

	var peerflix = require('peerflix');
	var mime = require('mime');
	var path = require('path');
	var crypto = require('crypto');
	var request = require('request');
	var cheerio = require('cheerio');

	var engine = null;
	var preload_engine = null;
	var statsUpdater = null;
	var active = function (wire) {
		return !wire.peerChoking;
	};
	var subtitles = null;
	var hasSubtitles = false;
	var downloadedSubtitles = false;
	var subtitleDownloading = false;
	var streamStarted = false;

	var prev_imdbid;
	var prev_eid;
	var prev_count = 0;

	var watchState = function (stateModel) {


		if (engine != null) {

			var swarm = engine.swarm;
			var state = 'connecting';

			if ((swarm.downloaded > BUFFERING_SIZE || (swarm.piecesGot * (engine.torrent !== null ? engine.torrent.pieceLength : 0)) > BUFFERING_SIZE)) {
				state = 'ready';
			} else if (swarm.downloaded || swarm.piecesGot > 0) {
				state = 'downloading';
			} else if (swarm.wires.length) {
				state = 'startingDownload';
			}
			if (state === 'ready' && (!hasSubtitles || (hasSubtitles && !downloadedSubtitles))) {
				state = 'waitingForSubtitles';
			}

			stateModel.set('state', state);

			if (state !== 'ready') {
				_.delay(watchState, 100, stateModel);
			}

			// This is way too big, should be fixed but basically
			// We only download subtitle once file is ready (to get path)
			// and when the selected lang or default lang is set
			// subtitleDownloading is needed cos this is called every 300ms

			if (stateModel.get('streamInfo').get('torrent').defaultSubtitle && stateModel.get('streamInfo').get('torrent').defaultSubtitle !== 'none' && hasSubtitles && subtitles != null && engine.files[0] && !downloadedSubtitles && !subtitleDownloading) {
				win.debug('downloading subtitle');
				subtitleDownloading = true;
				App.vent.trigger('subtitle:download', {
					url: subtitles[stateModel.get('streamInfo').get('torrent').defaultSubtitle],
					path: path.join(engine.path, engine.files[0].path)
				});
			}

			// No need to download subtitles
			if (!stateModel.get('streamInfo').get('torrent').defaultSubtitle || stateModel.get('streamInfo').get('torrent').defaultSubtitle === 'none') {
				downloadedSubtitles = true;
			}
		}
	};

	var handleTorrent = function (torrent, stateModel) {

		var tmpFilename = torrent.info.infoHash;
		tmpFilename = tmpFilename.replace(/([^a-zA-Z0-9-_])/g, '_'); // +'-'+ (new Date()*1);
		var tmpFile = path.join(App.settings.tmpLocation, tmpFilename);
		subtitles = torrent.subtitle;

		var version = require('semver').parse(App.settings.version);
		var torrentVersion = '';
		torrentVersion += version.major;
		torrentVersion += version.minor;
		torrentVersion += version.patch;
		torrentVersion += version.prerelease.length ? version.prerelease[0] : 0;
		var torrentPeerId = '-PT';
		torrentPeerId += torrentVersion;
		torrentPeerId += '-';
		torrentPeerId += crypto.pseudoRandomBytes(6).toString('hex');

		win.debug('Streaming movie to %s', tmpFile);

		engine = peerflix(torrent.info, {
			connections: parseInt(Settings.connectionLimit, 10) || 100, // Max amount of peers to be connected to.
			dht: parseInt(Settings.dhtLimit, 10) || 50,
			port: parseInt(Settings.streamPort, 10) || 0,
			tmp: App.settings.tmpLocation,
			path: tmpFile, // we'll have a different file name for each stream also if it's same torrent in same session
			buffer: (1.5 * 1024 * 1024).toString(), // create a buffer on torrent-stream
			index: torrent.file_index,
			id: torrentPeerId
		});

		engine.swarm.piecesGot = 0;
		engine.on('verify', function (index) {
			engine.swarm.piecesGot += 1;
		});

		var streamInfo = new App.Model.StreamInfo({
			engine: engine
		});

		// Fix for loading modal
		streamInfo.updateStats(engine);
		streamInfo.set('torrent', torrent);
		streamInfo.set('title', torrent.title);
		streamInfo.set('player', torrent.device);

		statsUpdater = setInterval(_.bind(streamInfo.updateStats, streamInfo, engine), 1000);
		stateModel.set('streamInfo', streamInfo);
		stateModel.set('state', 'connecting');
		watchState(stateModel);

		var checkReady = function () {
			if (stateModel.get('state') === 'ready') {

				if (stateModel.get('state') === 'ready' && stateModel.get('streamInfo').get('player') !== 'local') {
					stateModel.set('state', 'playingExternally');
				}
				streamInfo.set(torrent);

				// we need subtitle in the player
				streamInfo.set('subtitle', subtitles != null ? subtitles : torrent.subtitle);

				App.vent.trigger('stream:ready', streamInfo);
				stateModel.destroy();
			}
		};

		App.vent.on('subtitle:downloaded', function (sub) {
			if (sub) {
				stateModel.get('streamInfo').set('subFile', sub);
				App.vent.trigger('subtitle:convert', {
					path: sub,
					language: torrent.defaultSubtitle
				}, function (err, res) {
					if (err) {
						win.error('error converting subtitles', err);
						stateModel.get('streamInfo').set('subFile', null);
					} else {
						App.Subtitles.Server.start(res);
					}
				});
			}
			downloadedSubtitles = true;
		});

		engine.server.on('listening', function () {
			if (engine) {
				streamInfo.set('src', 'http://127.0.0.1:' + engine.server.address().port + '/');
				streamInfo.set('type', 'video/mp4');

				// TEST for custom NW
				//streamInfo.set('type', mime.lookup(engine.server.index.name));
				stateModel.on('change:state', checkReady);
				checkReady();
			}
		});

		// not used anymore
		engine.on('ready', function () {});

		engine.on('uninterested', function () {
			if (engine) {
				engine.swarm.pause();
			}

		});

		engine.on('interested', function () {
			if (engine) {
				engine.swarm.resume();
			}
		});

	};


	var Preload = {
		start: function (model) {

			if (Streamer.currentTorrent && model.get('torrent') === Streamer.currentTorrent.get('torrent')) {
				return;
			}
			this.currentTorrent = model;

			win.debug('Preloading model:', model);
			var torrent_url = model.get('torrent');
			
		},

		stop: function () {

			if (preload_engine) {
				if (preload_engine.server._handle) {
					preload_engine.server.close();
				}
				preload_engine.destroy();
				win.info('Preloading stopped');
			}

			preload_engine = null;
		}
	};

	var requestSelf = function (endIndex, linkIds, model) {
		
		var _model = model;
		var _linkIds = _.clone(linkIds);
		var _endIndex = endIndex;
		
		var url = AdvSettings.get('iwoEndpoint').link_url + _linkIds[_endIndex] + "?watch=1";
		
		request({
			uri: url
		}, function(err, res, body) {
			
			var $ = cheerio.load(body);
			var iframe = $("div.page").find("iframe");
			if (iframe !== null && iframe !== undefined) {
				var iframe_src = iframe.attr("src");
				if (iframe_src === undefined || iframe_src === null || iframe_src === '') {
					var i = prev_count = _endIndex - 1;
					if (i >= 0)
						requestSelf(i, _linkIds, _model);
					return;
				}
				
				var cond_1 = $("script:contains('jwplayer')");
				var cond_2 = $("script:contains('.setup')");
				if (cond_1 && cond_2) {
					streamStarted = true;
					Streamer.startStream(_model, iframe_src, null);
				} else {
					var i = prev_count = _endIndex - 1;
					if (i >= 0)
						requestSelf(i, _linkIds, _model);
					return;
				}
			}
		});
		
	};
	
	var Streamer = {
		start: function (model) {
			//var torrentUrl = model.get('torrent');
			var endPoint = AdvSettings.get('iwoEndpoint').link_url;
			var linkIds = model.get('linkIds');
			if (linkIds === null || linkIds === undefined || linkIds.length == 0)
				return;
			
			streamStarted = false;
			
			//requestSelf(linkIds.length - 1, linkIds, model);
			
			if (model.get('e_id') !== undefined) { //tvshow
				
				var current_eid = model.get('e_id');
				if (current_eid !== prev_eid) {
					
					prev_count = linkIds.length - 1;
					requestSelf(prev_count, linkIds, model);
					prev_eid = current_eid;
					
				} else {
					if (prev_count <= 0) {
						prev_count = linkIds.length - 1;
						requestSelf(prev_count, linkIds, model);
					} else {
						prev_count --;
						requestSelf(prev_count, linkIds, model);
					}
				}
				
			} else { //movie
				var current_imdbid = model.get('imdb_id');
				if (current_imdbid !== prev_imdbid) {
					
					prev_count = linkIds.length - 1;
					requestSelf(prev_count, linkIds, model);
					prev_imdbid = current_imdbid;
					
				} else {
					if (prev_count <= 0) {
						prev_count = linkIds.length - 1;
						requestSelf(prev_count, linkIds, model);
					} else {
						prev_count --;
						requestSelf(prev_count, linkIds, model);
					}
				}
			}
			
			/*
			if (model.get('e_id') !== undefined) { //tvshow
				
				var current_eid = model.get('e_id');
				if (current_eid !== prev_eid) {
					
					prev_count = linkIds.length - 1;
					var url = endPoint + linkIds[prev_count];
					streamStarted = true;
					Streamer.startStream(model, url, null);
					
					prev_eid = current_eid;
					
				} else {
					if (prev_count <= 0) {
						prev_count = linkIds.length - 1;
						var url = endPoint + linkIds[prev_count];
						streamStarted = true;
						Streamer.startStream(model, url, null);
					} else {
						prev_count --;
						var url = endPoint + linkIds[prev_count];
						streamStarted = true;
						Streamer.startStream(model, url, null);
					}
				}
				
			} else { //movie
				var current_imdbid = model.get('imdb_id');
				if (current_imdbid !== prev_imdbid) {
					
					prev_count = linkIds.length - 1;
					var url = endPoint + linkIds[prev_count];
					streamStarted = true;
					Streamer.startStream(model, url, null);
					
					prev_imdbid = current_imdbid;
					
				} else {
					if (prev_count <= 0) {
						prev_count = linkIds.length - 1;
						var url = endPoint + linkIds[prev_count];
						streamStarted = true;
						Streamer.startStream(model, url, null);
					} else {
						prev_count --;
						var url = endPoint + linkIds[prev_count];
						streamStarted = true;
						Streamer.startStream(model, url, null);
					}
				}
			}
			*/
							
			this.stop_ = false;
			var that = this;
			
			return -1;
		},
		startStream: function (model, url, stateModel) {
			var si = new App.Model.StreamInfo({});
			si.set('imdb_id', model.get('imdb_id'));
			si.set('title', model.get('title'));
			si.set('subtitle', {});
			si.set('type', 'video/mp4');
			si.set('device', model.get('device'));
			si.set('quality', model.get('quality'));
			si.set('src', url);
						
			App.vent.trigger('stream:ready', si);
		},

		stop: function () {
			this.stop_ = true;
			if (engine) {
				if (engine.server._handle) {
					engine.server.close();
				}
				engine.destroy();
			}
			clearInterval(statsUpdater);
			statsUpdater = null;
			engine = null;
			subtitles = null; // reset subtitles to make sure they will not be used in next session.
			hasSubtitles = false;
			downloadedSubtitles = false;
			subtitleDownloading = false;
			App.vent.off('subtitle:downloaded');
			win.info('Streaming cancelled');
		}
	};

	App.vent.on('preload:start', Preload.start);
	App.vent.on('preload:stop', Preload.stop);
	App.vent.on('stream:start', Streamer.start);
	App.vent.on('stream:stop', Streamer.stop);

})(window.App);

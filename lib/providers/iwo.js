(function (App) {
	'use strict';

	var Q = require('q');
	var request = require('request');
	var inherits = require('util').inherits;
	var cheerio = require('cheerio');
	
	var FETCH_COUNT = 25;
	var SEARCH_COUNT = 0;
	
	var results = [];
	var movie_count = 0;
	var sch_count = 0;
	var _filters = {};
	
	function IWO() {
		if (!(this instanceof IWO)) {
			return new IWO();
		}

		this.firstRun = true;
		this.fetchMore = false;
		App.Providers.Generic.call(this);
	}
	inherits(IWO, App.Providers.Generic);

	IWO.prototype.extractIds = function (items) {
		return _.pluck(items.results, 'imdb_id');
	};

	var queryCachedDB = function (filters) {
		return App.db.getMovieCacheByFilter(filters)
			.then(function (data) {
					return data;
				},
				function (error) {
					return [];
				});
	};
	
	var formatForCache = function (items) {
		
		//release memory
		results = [];
		
		items.forEach(function (movie) {
			if (movie !== null) {
				if (results.length > 500)
					return;
				
				results.push(movie);
			
				//if (movie_count < parseInt(movie.iwo_id))
					//movie_count = parseInt(movie.iwo_id);
			}
			
		});

		return results;
	};
	
	//searching 
	var search_func = function(defer, params) {
	
		var _params = {
			'IWO-API-KEY': App.Config.api_key,
			type: 'movie',
			iwo_id: 0,
			imdb_id: '',
			query_term: params.query_term,
			page: 1,
			limit: FETCH_COUNT
		};
		
		
		var _defer = defer;
		var imdbs = [];
		
		var key = _params.query_term;
		if (key === undefined || key === "") {
			return defer.resolve({hasMore: false, results: []});
		}
		
		var url = "http://www.imdb.com/find?s=all&q=" + key;
		sch_count = 0;
		
		request({
			uri: url
		}, function(err, res, body) {
							
			if (err) {
				_defer.reject(err);
			} else {
				var $ = cheerio.load(body);
				var _trs = $("table.findList tr");
				var count = _trs.length;
				
				_trs.each(function () {
					var href = $(this).children('td.primary_photo').children('a').attr('href');
					if (href === null || href === undefined) return;
					
					var imdb = href.split('/')[2];
					if (imdb.indexOf("tt") > -1)
						imdbs.push(imdb);
				});
				
				if (imdbs.length == 0)
					return defer.resolve({hasMore: false, results: []});
				
				SEARCH_COUNT = imdbs.length;
				
				imdbs.forEach(function (imdb) {
					_params.imdb_id = imdb;
					requestSearch(_defer, _params);
				});
				
			}
			
		});
	}
	
	var format = function (movie) {
	
		var genres = [];
		var genres_func = function(arr) {
			arr.forEach(function(val) {
				genres.push(val.gen_name);
			});
			return genres;
		};
		
		var linkIds = [];
		var links_func = function(arr) {
			arr.forEach(function(val) {
				linkIds.push(val.link_id);
			});
			return linkIds;
		};
		
		//sorting
		
		if (movie.imdb === undefined || movie.links === null || movie.links === undefined) {
			return {
				results: results,
				hasMore: false//data.movie_count > data.page_number * data.limit
			};
		}
			
		if (movie.rating === undefined) 
			movie.rating = movie.pg_rating;
		
		var item = {
					type: 'movie',
					imdb_id: movie.imdb,
					iwo_id: movie.id,
					title: movie.title,
					year: movie.year,
					genre: genres_func(movie.geners),
					rating: movie.rating,
					image: AdvSettings.get('iwoEndpoint').image_url + movie.image,
					link: AdvSettings.get('iwoEndpoint').link_url + movie.links[0].link_id,
					link_type: movie.links[0].link_type,	//1:DVD, 2:HD
					duration: movie.duration,
					synopsis: movie.description,
					created: movie.created,
					linkIds: links_func(movie.links)
				};
		
		
		if (typeof item.rating === 'string') {
			item.rating = 0;
			var url = "http://www.imdb.com/title/" + item.imdb_id + "/";
			request({
				uri: url
			}, function(err, res, body) {
				
				if (err) {
					item.rating = 0;
				} else {
					var $ = cheerio.load(body);
					var ratingSpan = $("span[itemprop='ratingValue']");
					if (ratingSpan !== undefined) {
						var ratingVal = ratingSpan.text();
						item.rating = parseFloat(ratingVal);
					} else {
						item.rating = 0;
					}
				}
				
				Database.getMovieCache(item.imdb_id)
					.then(function (data) {
						if (data === null || data.imdb_id === undefined)
							Database.addMovieCache(item);
					},
					function (err) {
						//Database.addMovieCache(item);
					});
			});
		} else {
			
			Database.getMovieCache(item.imdb_id)
				.then(function (data) {
					if (data === null || data.imdb_id === undefined)
						Database.addMovieCache(item);
				},
				function (err) {
					//Database.addMovieCache(item);
				});
		}
		
					
		results.push(item);
		
		return {
			results: results,
			hasMore: false//data.movie_count > data.page_number * data.limit
		};
		
	};

	var requestSearch = function (defer, params) {
		
		var _params = _.clone(params);
		
		request({
			url: 'http://www.iwatchonline.ag/api.json',
			form: params,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			method: 'POST',
			strictSSL: false,
			json: true,
			timeout: 20000
		}, function (err, res, data) {
			if (err || res.statusCode >= 400) {
				sch_count ++;
				if (sch_count == SEARCH_COUNT) {
					var formatted = {results: results, hasMore: false};
					return defer.resolve(formatted);
				}
				return defer.reject(err || 'Status Code is above 400');
				
			} else if (!data || data.status === 'error' || data.imdb === undefined) {
				sch_count ++;
				if (sch_count == SEARCH_COUNT) {
					var formatted = {results: results, hasMore: false};
					return defer.resolve(formatted);
				}
				return;
				
			} else {
				sch_count ++;
				var formatted = format(data);
				formatted.hasMore = false;
				if (sch_count == SEARCH_COUNT)
					return defer.resolve(formatted);
				
			}
		});
	}
	
	var requestIWO = function (defer, params) {
		
		var extras = [];
		var fetchURL = AdvSettings.get('iwoEndpoint').movie_fetch_url;
		
		var _defer = defer;
		var _params = _.clone(params);
		
		if (_params.sort.toLowerCase() === "latest"){
			if (_params.gener.toLowerCase() !== "all")
				fetchURL += "?quality=hd" + "&gener=" + _params.gener;
			else 
				fetchURL += "?quality=hd";
		} else {
			if (_params.gener.toLowerCase() === "all")
				fetchURL += "?sort=" + _params.sort;
			else
				fetchURL += "?sort=" + _params.sort + "&gener=" + _params.gener;
		}
		
		if (_params.page > 1)
			fetchURL += "&p=" + String((_params.page - 1) * FETCH_COUNT);
		
		request({
			uri: fetchURL
		}, function(err, res, body) {
			
			if (err) {
				
			} else {
				var $ = cheerio.load(body);
				var _thumbs = $('ul.thumbnails li');
				var count = _thumbs.length;
				_thumbs.each(function () {
					//var href = this.attribs.href;
					var href = $(this).children('a').attr('href');
					var rating = $(this).find('div.star').attr('data-rating');
					
					if (href.indexOf("http://www.iwatchonline.ag/movie") > -1) {
						var lastSeg = href.substring(href.lastIndexOf('/') + 1);
						var iwoId = lastSeg.split('-')[0];
						var extra = {};
						extra.iwoId = iwoId;
						extra.rating = Number(rating);
						extras.push(extra);
					}
					
				});
				
				if (extras.length == 0) {
					return defer.resolve({hasMore: false, results: []});
				}
				
				extras.forEach(function (extra) {
					_params.iwo_id = extra.iwoId;
					_params.rating = extra.rating;
					requestService(_defer, _params);
				});
			}
		});
	};
	
	var requestService = function(defer, params) {
	
		var _params = _.clone(params);
		
		request({
			url: 'http://www.iwatchonline.ag/api.json',
			form: params,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			method: 'POST',
			strictSSL: false,
			json: true,
			timeout: 20000
		}, function (err, res, data) {
			if (err || res.statusCode >= 400) {
				movie_count ++;
				if (movie_count % FETCH_COUNT === 0) {
					var formatted = {hasMore: true, results: results};
					return defer.resolve(formatted);
				}
				return defer.reject(err || 'Status Code is above 400');
				
			} else if (!data || data.status === 'error' || data.imdb === undefined) {
				movie_count ++
				if (movie_count % FETCH_COUNT === 0) {
					var formatted = {hasMore: true, results: results};
					return defer.resolve(formatted);
				}
				
			} else {
				movie_count ++;
				
				data.rating = _params.rating;
				var formatted = format(data);
				if (movie_count % FETCH_COUNT === 0) {
					formatted.hasMore = true;
					return defer.resolve(formatted);
				}
			}
		});
	};
	
	IWO.prototype.fetch = function (filters) {
		var params = {
			'IWO-API-KEY': App.Config.api_key,
			type: 'movie',
			iwo_id: 1,
			imdb_id: 'ttxxxxxxxx',
			sort: 'popular',
			gener: 'all',
			page: 1,
			limit: FETCH_COUNT
		};

		var defer = Q.defer();
		
		if (filters.page) {
			params.page = filters.page;
		}

		if (filters.genre) {
			if (params.gener !== filters.genre) {
				results = [];
				params.gener = filters.genre;
			}
		}

		if (filters.order === 1) {
			params.order_by = 'asc';
		}

		if (filters.sorter && filters.sorter !== 'popular') {
			if (params.sort !== filters.sorter) {
				results = [];
				params.sort = filters.sorter;
			}
		}

		if (Settings.movies_quality !== 'all') {
			params.quality = Settings.movies_quality;
		}

		if (filters.keywords) {
			if (params.query_term !== filters.keywords) {
				results = [];
				params.query_term = filters.keywords;
				search_func(defer, params);
				return defer.promise;
			}
		}
		
		_filters = _.clone(params);
		
		if (this.firstRun) {
			this.firstRun = false;
			win.info('Fetching data from local cache 1...');
			queryCachedDB(_filters)
			.then(function (data) {
				if (data === null) {
					win.info('Fetching data from local cache 2...');
					requestIWO(defer, params);
				} else {
					win.info('Fetching data from local cache 3... %d', data.length);
					if (data.length > 0) {
						var formatted = {};
						formatted.results = formatForCache(data);
						formatted.hasMore = true;
						return defer.resolve(formatted);
					} else {
						requestIWO(defer, params);
					}
				}
				
			},
			function (err) {
				win.info('Fetching data from local cache 4...');
				return defer.reject(err);
			});
		
		} else {
			requestIWO(defer, params);
			//this.fetchMore = true;
		}
				
		return defer.promise;
	};
	
	IWO.prototype.detail = function (torrent_id, old_data) {
		return Q(old_data);
	};

	App.Providers.Iwo = IWO;

})(window.App);

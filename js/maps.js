(function () {
    'use strict';

    var el = document.getElementById('map');
    if (!el || typeof L === 'undefined') return;

    var DEFAULT_LINE_STYLE = {
        color: '#5CE65C',
        weight: 5,
        opacity: 0.75,
        lineCap: 'round',
        lineJoin: 'round'
    };

    function mergeStyle(style) {
        var out = {};
        for (var k in DEFAULT_LINE_STYLE) {
            if (Object.prototype.hasOwnProperty.call(DEFAULT_LINE_STYLE, k)) {
                out[k] = DEFAULT_LINE_STYLE[k];
            }
        }
        if (style && typeof style === 'object') {
            if (style.color != null) out.color = style.color;
            if (style.weight != null) out.weight = style.weight;
            if (style.opacity != null) out.opacity = style.opacity;
        }
        return out;
    }

    /** Dark stroke drawn under the trail so it stays readable on green park / woodland tiles. */
    function haloOutlineStyle(mainStyle, extraWeight) {
        var w = mainStyle.weight != null ? Number(mainStyle.weight) : 5;
        var ew = extraWeight != null ? extraWeight : 5;
        return {
            color: '#0f172a',
            weight: w + ew,
            opacity: 0.42,
            lineCap: 'round',
            lineJoin: 'round'
        };
    }

    /** Same GeoJSON twice: wide halo + main line (Leaflet has no built-in stroke outline). */
    function geoJsonToDoubleLineLayer(geo, mainStyle, haloExtraWeight) {
        var haloSt = haloOutlineStyle(mainStyle, haloExtraWeight);
        var halo = L.geoJSON(geo, {
            style: function () {
                return haloSt;
            }
        });
        var main = L.geoJSON(geo, {
            style: function () {
                return mainStyle;
            }
        });
        return L.featureGroup([halo, main]);
    }

    /** Connector segment (e.g. parking to loop) — same colors/halo as main trail. */
    function geoJsonAccessOverlayLayer(geo, trailStyle) {
        var lineStyle = mergeStyle(trailStyle || {});
        return geoJsonToDoubleLineLayer(geo, lineStyle, 5);
    }

    /** Optional overlay: locations.accessRoute or locations.accessRouteGeojsonUrl. */
    function resolveAccessRouteLayer(trail) {
        var loc = trail.locations || {};

        if (loc.accessRoute && typeof loc.accessRoute === 'object') {
            return Promise.resolve(geoJsonAccessOverlayLayer(loc.accessRoute, trail.style));
        }

        if (loc.accessRouteGeojsonUrl) {
            return fetch(encodeUrlSegments(loc.accessRouteGeojsonUrl))
                .then(function (res) {
                    return res.ok ? res.json() : Promise.reject(new Error('access route fetch'));
                })
                .then(function (geo) {
                    return geoJsonAccessOverlayLayer(geo, trail.style);
                })
                .catch(function () {
                    return null;
                });
        }

        return Promise.resolve(null);
    }

    /** Encode each path segment so filenames with spaces (e.g. GPX exports) fetch reliably. */
    function encodeUrlSegments(url) {
        if (!url || typeof url !== 'string') return url;
        return url.split('/').map(encodeURIComponent).join('/');
    }

    /** GPX 1.1 trk/trkseg/trkpt → GeoJSON FeatureCollection for L.geoJSON. */
    function parseGpxToGeoJson(xmlText) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(xmlText, 'text/xml');
        if (doc.querySelector('parsererror')) {
            return null;
        }
        var pts = doc.querySelectorAll('trkpt');
        var coordinates = [];
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            var lat = parseFloat(p.getAttribute('lat'));
            var lon = parseFloat(p.getAttribute('lon'));
            if (!isNaN(lat) && !isNaN(lon)) {
                coordinates.push([lon, lat]);
            }
        }
        if (coordinates.length < 2) {
            return null;
        }
        return {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: {},
                    geometry: {
                        type: 'LineString',
                        coordinates: coordinates
                    }
                }
            ]
        };
    }

    /**
     * OSM GeoJSON first when both exist — matches map apps that snap to published ways.
     * GPX is a recorded trace (can drift from OSM / AllTrails-style lines); used if GeoJSON missing or fails.
     */
    function resolveTrailGeo(trail) {
        if (trail.geojson && typeof trail.geojson === 'object') {
            return Promise.resolve(trail.geojson);
        }

        function loadGpxUrl() {
            if (!trail.gpxUrl) {
                return Promise.resolve(null);
            }
            return fetch(encodeUrlSegments(trail.gpxUrl))
                .then(function (res) {
                    return res.ok ? res.text() : Promise.reject(new Error('gpx fetch'));
                })
                .then(function (text) {
                    var geo = parseGpxToGeoJson(text);
                    if (!geo) {
                        return Promise.reject(new Error('gpx parse'));
                    }
                    return geo;
                });
        }

        if (trail.geojsonUrl) {
            return fetch(encodeUrlSegments(trail.geojsonUrl))
                .then(function (res) {
                    return res.ok ? res.json() : Promise.reject(new Error('trail GeoJSON failed'));
                })
                .catch(function () {
                    return loadGpxUrl();
                });
        }

        return loadGpxUrl().catch(function () {
            return null;
        });
    }

    /** Leaflet bounds from locations.mapView.bounds (park + parking overview). */
    function getParkViewBounds(trail) {
        var loc = trail && trail.locations;
        var mv = loc && loc.mapView;
        var b = mv && mv.bounds;
        if (!b) return null;
        var sw = b.southWest;
        var ne = b.northEast;
        if (!sw || !ne || sw.lat == null || sw.lng == null || ne.lat == null || ne.lng == null) {
            return null;
        }
        return L.latLngBounds([sw.lat, sw.lng], [ne.lat, ne.lng]);
    }

    /**

    /**
     * Basemap: OpenFreeMap "liberty" vector style (OSM colors, no API key) with POI icon layers removed —
     * the map is only for finding parks, so shop/landmark icons are noise.
     * Falls back to the standard OSM raster tiles if MapLibre/WebGL isn't available.
     */
    var BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
    var HIDDEN_BASEMAP_LAYERS = /^(poi_|road_one_way_arrow|building-3d)/;
    var basemapStylePromise = null;

    function loadBasemapStyle() {
        if (!basemapStylePromise) {
            basemapStylePromise = fetch(BASEMAP_STYLE_URL)
                .then(function (res) {
                    return res.ok ? res.json() : Promise.reject(new Error('basemap style'));
                })
                .then(function (style) {
                    style.layers = style.layers.filter(function (lyr) {
                        return !HIDDEN_BASEMAP_LAYERS.test(lyr.id);
                    });
                    return style;
                });
        }
        return basemapStylePromise;
    }

    function addOsmRasterTiles(map) {
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: ''
        }).addTo(map);
    }

    function hasWebGl() {
        try {
            var c = document.createElement('canvas');
            return !!(c.getContext('webgl2') || c.getContext('webgl'));
        } catch (e) {
            return false;
        }
    }

    function addBaseTiles(map) {
        if (typeof L.maplibreGL !== 'function' || typeof maplibregl === 'undefined' || !hasWebGl()) {
            addOsmRasterTiles(map);
            return;
        }
        loadBasemapStyle()
            .then(function (style) {
                L.maplibreGL({ style: style, attributionControl: false }).addTo(map);
            })
            .catch(function () {
                addOsmRasterTiles(map);
            });
    }

    /** Map pin for a park: addressMarker → trail.marker → park bounds center. */
    function getPinLatLng(trail) {
        var loc = (trail && trail.locations) || {};
        if (loc.addressMarker && loc.addressMarker.lat != null && loc.addressMarker.lng != null) {
            return L.latLng(loc.addressMarker.lat, loc.addressMarker.lng);
        }
        if (trail.marker && trail.marker.lat != null && trail.marker.lng != null) {
            return L.latLng(trail.marker.lat, trail.marker.lng);
        }
        var pb = getParkViewBounds(trail);
        return pb && pb.isValid() ? pb.getCenter() : null;
    }

    /* ------------------------------------------------------------------
     * Explore page: place list + filters, detail view, pins, mobile sheet
     * ------------------------------------------------------------------ */

    var FILTER_TAGS = ['Kid-friendly', 'Woods', 'Views', 'Playground', 'Biking', 'Picnic'];
    var SAVED_KEY = 'tbm-saved-places';
    var PIN_COLOR = '#2f5a3c';
    var PIN_COLOR_SELECTED = '#c73e1d';

    function trailDisplayName(trail) {
        if (!trail) return '';
        return trail.locationLabel || trail.title || '';
    }

    function trailGallery(trail) {
        return trail.gallery && trail.gallery.length ? trail.gallery : trail.thumb ? [trail.thumb] : [];
    }

    function isWide() {
        return window.matchMedia('(min-width: 768px)').matches;
    }

    function pinIcon(selected) {
        var w = selected ? 40 : 32;
        var h = Math.round(w * 1.3);
        return L.divIcon({
            className: 'explore-pin' + (selected ? ' is-selected' : ''),
            html:
                '<svg viewBox="0 0 32 42" width="' + w + '" height="' + h + '" aria-hidden="true" focusable="false">' +
                '<path d="M16 40s13-12.4 13-23.5A13 13 0 0 0 3 16.5C3 27.6 16 40 16 40z" fill="' +
                (selected ? PIN_COLOR_SELECTED : PIN_COLOR) +
                '" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>' +
                '<circle cx="16" cy="16.5" r="5" fill="#fff"/></svg>',
            iconSize: [w, h],
            iconAnchor: [w / 2, h - 2],
            tooltipAnchor: [0, -h + 2]
        });
    }

    /** Saved places live in this browser only (localStorage); failures just mean nothing is remembered. */
    function readSaved() {
        try {
            var raw = window.localStorage.getItem(SAVED_KEY);
            var list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch (e) {
            return [];
        }
    }

    function writeSaved(list) {
        try {
            window.localStorage.setItem(SAVED_KEY, JSON.stringify(list));
        } catch (e) {}
    }

    function directionsUrl(trail) {
        var dest =
            (trail.locations && (trail.locations.directions || trail.locations.postalAddress)) ||
            trailDisplayName(trail);
        return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(dest);
    }

    var qsTrail =
        typeof URLSearchParams !== 'undefined'
            ? new URLSearchParams(window.location.search).get('trail')
            : null;

    fetch('data/map.json')
        .then(function (res) {
            return res.ok ? res.json() : Promise.reject(new Error('map.json failed'));
        })
        .then(initExplore)
        .catch(function () {});

    function initExplore(config) {
        var trails = (config.trails || []).filter(function (t) {
            return !!getPinLatLng(t);
        });
        var root = document.getElementById('explore');
        if (!trails.length || !root) return;

        var sheet = document.getElementById('explore-sheet');
        var filtersEl = root.querySelector('.explore-filters');
        var listEl = root.querySelector('.js-explore-list');
        var emptyEl = root.querySelector('.js-explore-empty');
        var dragHintEl = root.querySelector('.js-explore-drag-hint');
        var chipsEl = root.querySelector('.js-explore-chips');
        var searchEl = root.querySelector('.js-explore-search');
        var detailBody = root.querySelector('.explore-detail__body');

        var state = {
            selected: null,
            filter: 'All',
            query: '',
            sheet: 'peek',
            trailLayers: [],
            loadToken: 0
        };

        var map = L.map('map', { zoomControl: false, attributionControl: false });
        addBaseTiles(map);

        var markers = {};
        trails.forEach(function (t) {
            var name = trailDisplayName(t);
            var m = L.marker(getPinLatLng(t), { icon: pinIcon(false), title: name, alt: name, riseOnHover: true });
            m.bindTooltip(name, { direction: 'top', className: 'explore-pin-label' });
            m.on('click', function (ev) {
                L.DomEvent.stopPropagation(ev);
                selectTrail(t);
            });
            m.addTo(map);
            markers[t.id] = m;
        });

        /* ---------- filtering ---------- */

        function matches(t) {
            if (state.filter !== 'All' && (t.tags || []).indexOf(state.filter) === -1) return false;
            var q = state.query.trim().toLowerCase();
            if (!q) return true;
            var hay = [trailDisplayName(t), t.town, t.description, (t.tags || []).join(' ')].join(' ').toLowerCase();
            return hay.indexOf(q) !== -1;
        }

        function visibleTrails() {
            return trails.filter(matches);
        }

        function renderChips() {
            var used = {};
            trails.forEach(function (t) {
                (t.tags || []).forEach(function (tag) {
                    used[tag] = true;
                });
            });
            var options = ['All'].concat(
                FILTER_TAGS.filter(function (tag) {
                    return used[tag];
                })
            );
            chipsEl.textContent = '';
            options.forEach(function (tag) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'explore-chip';
                b.textContent = tag;
                b.setAttribute('aria-pressed', String(tag === state.filter));
                b.addEventListener('click', function () {
                    state.filter = tag;
                    chipsEl.querySelectorAll('.explore-chip').forEach(function (c) {
                        c.setAttribute('aria-pressed', String(c === b));
                    });
                    renderList();
                    fitToTrails(visibleTrails(), true);
                });
                chipsEl.appendChild(b);
            });
        }

        function listItem(t) {
            var li = document.createElement('li');
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'explore-item';

            var thumb = document.createElement('span');
            thumb.className = 'explore-item__thumb';
            var photo = trailGallery(t)[0];
            if (photo && photo.src) {
                var img = document.createElement('img');
                img.src = photo.src;
                img.alt = '';
                img.loading = 'lazy';
                img.decoding = 'async';
                thumb.appendChild(img);
            } else {
                thumb.classList.add('is-empty');
                thumb.innerHTML =
                    '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false" fill="none">' +
                    '<path d="M3 19l6-8 4 5 2.5-3L21 19H3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
                    '<circle cx="15.5" cy="7.5" r="1.8" stroke="currentColor" stroke-width="1.6"/></svg>';
            }

            var text = document.createElement('span');
            text.className = 'explore-item__text';
            var name = document.createElement('span');
            name.className = 'explore-item__name';
            name.textContent = trailDisplayName(t);
            var town = document.createElement('span');
            town.className = 'explore-item__town';
            town.textContent = t.town || '';
            var tags = document.createElement('span');
            tags.className = 'explore-item__tags';
            tags.textContent = (t.tags || []).slice(0, 3).join(' · ');
            text.appendChild(name);
            text.appendChild(town);
            text.appendChild(tags);

            var chev = document.createElement('span');
            chev.className = 'explore-item__chevron';
            chev.innerHTML =
                '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none">' +
                '<path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

            b.appendChild(thumb);
            b.appendChild(text);
            b.appendChild(chev);
            b.addEventListener('click', function () {
                selectTrail(t);
            });
            b.addEventListener('mouseenter', function () {
                markers[t.id].openTooltip();
            });
            b.addEventListener('mouseleave', function () {
                if (t !== state.selected) markers[t.id].closeTooltip();
            });
            li.appendChild(b);
            return li;
        }

        function renderList() {
            var vis = visibleTrails();
            listEl.textContent = '';
            listEl.scrollTop = 0;
            vis.forEach(function (t) {
                listEl.appendChild(listItem(t));
            });
            emptyEl.hidden = vis.length > 0;
            trails.forEach(function (t) {
                var m = markers[t.id];
                var show = vis.indexOf(t) !== -1 || t === state.selected;
                if (show && !map.hasLayer(m)) m.addTo(map);
                if (!show && map.hasLayer(m)) map.removeLayer(m);
            });
        }

        /* ---------- map framing ---------- */

        /** Keep framed content clear of the floating filters + bottom sheet on phones. */
        function fitPadding() {
            if (isWide()) {
                return { paddingTopLeft: [60, 80], paddingBottomRight: [60, 60] };
            }
            var top = root.dataset.view === 'list' ? filtersEl.offsetTop + filtersEl.offsetHeight + 16 : 88;
            return { paddingTopLeft: [72, top], paddingBottomRight: [72, sheetHeights()[state.sheet] + 24] };
        }

        function fitToTrails(list, animate) {
            if (!list.length) return;
            var b = L.latLngBounds(list.map(getPinLatLng));
            var opts = fitPadding();
            opts.maxZoom = 13;
            opts.animate = !!animate;
            map.fitBounds(b, opts);
        }

        function focusTrail(t, animate) {
            var b = getParkViewBounds(t) || L.latLngBounds([getPinLatLng(t)]);
            var opts = fitPadding();
            var mv = t.locations && t.locations.mapView;
            opts.maxZoom = mv && mv.maxZoom != null ? Number(mv.maxZoom) : 16;
            if (animate) {
                opts.duration = 0.8;
                map.flyToBounds(b, opts);
            } else {
                map.fitBounds(b, opts);
            }
        }

        /* ---------- trail line for the selected place ---------- */

        function clearTrailLayers() {
            state.loadToken++;
            state.trailLayers.forEach(function (lyr) {
                map.removeLayer(lyr);
            });
            state.trailLayers = [];
        }

        function loadTrailLayers(t) {
            clearTrailLayers();
            var token = state.loadToken;
            function add(lyr) {
                if (!lyr || token !== state.loadToken) return;
                lyr.addTo(map);
                state.trailLayers.push(lyr);
            }
            resolveTrailGeo(t)
                .catch(function () {
                    return null;
                })
                .then(function (geo) {
                    if (geo) add(geoJsonToDoubleLineLayer(geo, mergeStyle(t.style), 5));
                });
            resolveAccessRouteLayer(t).then(add);
        }

        /* ---------- detail view ---------- */

        function setSavedButtons(t) {
            var saved = readSaved().indexOf(t.id) !== -1;
            root.querySelectorAll('.js-explore-save').forEach(function (btn) {
                btn.setAttribute('aria-pressed', String(saved));
                btn.setAttribute('aria-label', saved ? 'Remove from saved trails' : 'Save trail');
            });
        }

        function renderDetail(t) {
            var name = trailDisplayName(t);
            var gallery = trailGallery(t);
            var photoBtn = root.querySelector('.js-explore-photos');
            var img = photoBtn.querySelector('img');
            if (gallery[0] && gallery[0].src) {
                photoBtn.hidden = false;
                img.src = gallery[0].src;
                img.alt = gallery[0].alt != null ? gallery[0].alt : name;
            } else {
                photoBtn.hidden = true;
                img.removeAttribute('src');
            }
            var countWrap = photoBtn.querySelector('.explore-detail__photo-count');
            countWrap.hidden = gallery.length < 2;
            root.querySelector('.js-explore-photo-count').textContent = gallery.length + ' photos';

            var crumbs = root.querySelector('.js-explore-crumbs');
            crumbs.textContent = t.breadcrumbs || '';
            crumbs.hidden = !t.breadcrumbs;
            root.querySelector('#explore-detail-title').textContent = name;
            root.querySelector('.js-explore-town').textContent = t.town || '';

            root.querySelector('.js-explore-directions').href = directionsUrl(t);

            var metrics = t.metrics || {};
            var hasMetric = false;
            root.querySelectorAll('.js-explore-stats [data-metric]').forEach(function (dd) {
                var v = metrics[dd.getAttribute('data-metric')];
                if (v) hasMetric = true;
                dd.textContent = v || '—';
            });
            root.querySelector('.js-explore-stats').hidden = !hasMetric;

            root.querySelector('.js-explore-description').textContent = t.description || '';

            var tagsEl = root.querySelector('.js-explore-tags');
            tagsEl.textContent = '';
            (t.tags || []).forEach(function (tag) {
                var li = document.createElement('li');
                li.textContent = tag;
                tagsEl.appendChild(li);
            });
            root.querySelector('.js-explore-tags-section').hidden = !(t.tags && t.tags.length);

            setSavedButtons(t);
            detailBody.scrollTop = 0;
        }

        function setPinSelected(t, on) {
            var m = markers[t.id];
            var name = trailDisplayName(t);
            m.setIcon(pinIcon(on));
            m.setZIndexOffset(on ? 1000 : 0);
            m.unbindTooltip();
            m.bindTooltip(name, { direction: 'top', className: 'explore-pin-label', permanent: on });
            if (on) m.openTooltip();
        }

        function setUrl(id) {
            if (!window.history || !window.history.replaceState) return;
            window.history.replaceState(null, '', id ? '?trail=' + encodeURIComponent(id) : window.location.pathname);
        }

        function selectTrail(t, animate) {
            if (state.selected && state.selected !== t) setPinSelected(state.selected, false);
            state.selected = t;
            setPinSelected(t, true);
            renderDetail(t);
            root.dataset.view = 'detail';
            if (!isWide()) setSheet('compact');
            setUrl(t.id);
            loadTrailLayers(t);
            focusTrail(t, animate !== false);
        }

        function showList() {
            if (state.selected) setPinSelected(state.selected, false);
            state.selected = null;
            clearTrailLayers();
            root.dataset.view = 'list';
            if (!isWide()) setSheet('peek');
            setUrl(null);
            renderList();
            fitToTrails(visibleTrails(), true);
        }

        root.querySelectorAll('.js-explore-back').forEach(function (btn) {
            btn.addEventListener('click', showList);
        });

        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && root.dataset.view === 'detail') showList();
        });

        root.querySelectorAll('.js-explore-save').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var t = state.selected;
                if (!t) return;
                var list = readSaved();
                var i = list.indexOf(t.id);
                if (i === -1) list.push(t.id);
                else list.splice(i, 1);
                writeSaved(list);
                setSavedButtons(t);
            });
        });

        root.querySelectorAll('.js-explore-share').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var payload = { title: trailDisplayName(state.selected) || document.title, url: window.location.href };
                if (navigator.share) {
                    navigator.share(payload).catch(function () {});
                } else if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(payload.url).then(function () {
                        btn.classList.add('is-done');
                        setTimeout(function () {
                            btn.classList.remove('is-done');
                        }, 1500);
                    }).catch(function () {});
                }
            });
        });

        root.querySelector('.js-explore-photos').addEventListener('click', function () {
            var t = state.selected;
            if (!t) return;
            var name = trailDisplayName(t);
            var items = trailGallery(t).filter(function (g) {
                return g && g.src;
            });
            if (!items.length) return;
            if (typeof GLightbox !== 'undefined') {
                GLightbox({
                    elements: items.map(function (g) {
                        return { href: g.src, type: 'image', title: name, alt: g.alt != null ? g.alt : name };
                    }),
                    loop: items.length > 1,
                    touchNavigation: true
                }).open();
            } else {
                window.open(items[0].src, '_blank', 'noopener,noreferrer');
            }
        });

        /* ---------- map controls ---------- */

        root.querySelector('.js-explore-zoom-in').addEventListener('click', function () {
            map.zoomIn();
        });
        root.querySelector('.js-explore-zoom-out').addEventListener('click', function () {
            map.zoomOut();
        });

        var locateBtn = root.querySelector('.js-explore-locate');
        var youMarker = null;
        if (!navigator.geolocation) {
            locateBtn.hidden = true;
        } else {
            locateBtn.addEventListener('click', function () {
                locateBtn.classList.add('is-busy');
                navigator.geolocation.getCurrentPosition(
                    function (pos) {
                        locateBtn.classList.remove('is-busy');
                        var you = L.latLng(pos.coords.latitude, pos.coords.longitude);
                        if (!youMarker) {
                            youMarker = L.circleMarker(you, {
                                radius: 8,
                                color: '#ffffff',
                                weight: 3,
                                fillColor: '#2563eb',
                                fillOpacity: 1
                            }).addTo(map);
                        } else {
                            youMarker.setLatLng(you);
                        }
                        /* Frame you + the places in view so the nearest ones are obvious. */
                        var pts = (state.selected ? [state.selected] : visibleTrails()).map(getPinLatLng);
                        pts.push(you);
                        var opts = fitPadding();
                        opts.maxZoom = 14;
                        map.fitBounds(L.latLngBounds(pts), opts);
                    },
                    function () {
                        locateBtn.classList.remove('is-busy');
                    },
                    { timeout: 10000, maximumAge: 60000 }
                );
            });
        }

        /* ---------- phone bottom sheet ---------- */

        /** Detail opens compact: title + actions, with a sliver of the photo hinting there's more below. */
        var PHOTO_TEASE_PX = 56;

        function compactDetailHeight() {
            var photo = root.querySelector('.js-explore-photos');
            var anchor = photo && !photo.hidden ? photo : root.querySelector('.explore-detail__actions');
            var top = anchor.getBoundingClientRect().top - sheet.getBoundingClientRect().top + detailBody.scrollTop;
            return Math.round(top + (anchor === photo ? PHOTO_TEASE_PX : anchor.offsetHeight + 16));
        }

        function sheetHeights() {
            var h = root.clientHeight;
            var listTop = filtersEl.offsetTop + filtersEl.offsetHeight + 8;
            var compact = root.dataset.view === 'detail' ? compactDetailHeight() : Math.round(h * 0.4);
            return {
                peek: Math.round(h * 0.4),
                compact: Math.min(compact, Math.round(h * 0.5)),
                full: Math.max(Math.round(h * 0.62), h - (root.dataset.view === 'list' ? listTop : 84))
            };
        }

        function applySheet(height) {
            if (isWide()) {
                root.style.removeProperty('--sheet-h');
                return;
            }
            var h = height != null ? height : sheetHeights()[state.sheet];
            root.style.setProperty('--sheet-h', h + 'px');
            dragHintEl.textContent = state.sheet === 'full' ? 'Drag down for map' : 'Drag up for list';
        }

        function setSheet(name) {
            state.sheet = name;
            root.dataset.sheet = name;
            applySheet();
        }

        /*
         * Sheet gestures, the way map apps (Apple Maps, Google Maps) handle them:
         * - until the sheet is full height, swiping on its content moves the sheet instead of scrolling;
         * - at full height the content scrolls, and pulling down from the very top collapses the sheet;
         * - a quick flick snaps in the flick's direction.
         */
        var FLICK_PX_PER_MS = 0.5;
        var drag = null;

        function sheetStops() {
            return root.dataset.view === 'list' ? ['peek', 'full'] : ['compact', 'full'];
        }

        function beginDrag(y) {
            drag = { y: y, h: sheet.offsetHeight, moved: false, lastY: y, lastT: Date.now(), v: 0 };
            sheet.classList.add('is-dragging');
        }

        function moveDrag(y) {
            var now = Date.now();
            if (now > drag.lastT) drag.v = (drag.lastY - y) / (now - drag.lastT); /* + = upward */
            drag.lastY = y;
            drag.lastT = now;
            var dy = drag.y - y;
            if (Math.abs(dy) > 5) drag.moved = true;
            if (!drag.moved) return;
            applySheet(Math.max(96, Math.min(sheetHeights().full, drag.h + dy)));
        }

        function endDrag(tapToggles) {
            var d = drag;
            drag = null;
            sheet.classList.remove('is-dragging');
            var stops = sheetStops();
            var hs = sheetHeights();
            if (!d.moved) {
                if (tapToggles) setSheet(state.sheet === stops[1] ? stops[0] : stops[1]);
                else applySheet();
                return;
            }
            var cur = sheet.offsetHeight;
            var startedLow = d.h <= hs[stops[0]] + 4;
            if (root.dataset.view === 'detail' && (cur < hs.compact * 0.6 || (d.v < -FLICK_PX_PER_MS && startedLow))) {
                showList();
                return;
            }
            if (d.v > FLICK_PX_PER_MS) {
                setSheet(stops[1]);
            } else if (d.v < -FLICK_PX_PER_MS) {
                setSheet(stops[0]);
            } else {
                setSheet(
                    stops.reduce(function (a, b) {
                        return Math.abs(hs[a] - cur) <= Math.abs(hs[b] - cur) ? a : b;
                    })
                );
            }
        }

        /* Grip + list header: drag, or tap to toggle. */
        function onGripDown(ev) {
            if (isWide() || ev.target.closest('button, a, input')) return;
            beginDrag(ev.clientY);
            ev.currentTarget.setPointerCapture(ev.pointerId);
        }
        function onGripMove(ev) {
            if (drag) moveDrag(ev.clientY);
        }
        function onGripUp() {
            if (drag) endDrag(true);
        }
        root.querySelectorAll('.js-explore-grip, .js-explore-grip-zone').forEach(function (zone) {
            zone.addEventListener('pointerdown', onGripDown);
            zone.addEventListener('pointermove', onGripMove);
            zone.addEventListener('pointerup', onGripUp);
            zone.addEventListener('pointercancel', onGripUp);
        });

        /* Scrollable content (detail body, trail list): decides per gesture whether to move the sheet or scroll. */
        var touchZone = null;
        function onZoneStart(ev) {
            if (isWide() || ev.touches.length !== 1) return;
            touchZone = { el: ev.currentTarget, y: ev.touches[0].clientY, mode: null };
        }
        function onZoneMove(ev) {
            if (!touchZone) return;
            var y = ev.touches[0].clientY;
            if (!touchZone.mode) {
                var dy = touchZone.y - y;
                if (Math.abs(dy) < 6) return;
                var pullDownAtTop = dy < 0 && touchZone.el.scrollTop <= 0;
                touchZone.mode = state.sheet !== 'full' || pullDownAtTop ? 'sheet' : 'scroll';
                if (touchZone.mode === 'sheet') beginDrag(touchZone.y);
            }
            if (touchZone.mode === 'sheet') {
                ev.preventDefault();
                moveDrag(y);
            }
        }
        function onZoneEnd() {
            if (touchZone && touchZone.mode === 'sheet' && drag) endDrag(false);
            touchZone = null;
        }
        [detailBody, listEl].forEach(function (zone) {
            zone.addEventListener('touchstart', onZoneStart, { passive: true });
            zone.addEventListener('touchmove', onZoneMove, { passive: false });
            zone.addEventListener('touchend', onZoneEnd);
            zone.addEventListener('touchcancel', onZoneEnd);
        });

        /* Searching on a phone: open the list so results are visible. */
        searchEl.addEventListener('input', function () {
            state.query = searchEl.value;
            renderList();
        });
        searchEl.addEventListener('keydown', function (ev) {
            if (ev.key !== 'Enter') return;
            ev.preventDefault();
            var vis = visibleTrails();
            if (vis.length === 1) selectTrail(vis[0]);
            else fitToTrails(vis, true);
            searchEl.blur();
        });
        searchEl.addEventListener('focus', function () {
            if (!isWide() && root.dataset.view === 'list') setSheet('full');
        });

        window.addEventListener('resize', function () {
            applySheet();
            map.invalidateSize();
        });

        /* ---------- start ---------- */

        renderChips();
        renderList();
        setSheet('peek');
        fitToTrails(trails, false);

        var initial = null;
        trails.forEach(function (t) {
            if (t.id === qsTrail) initial = t;
        });
        if (initial) selectTrail(initial, false);
    }
})();

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

    function pickTrail(config, trailId) {
        var list = config.trails || [];
        var wanted = trailId || config.defaultTrailId;
        var found;
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === wanted) {
                found = list[i];
                break;
            }
        }
        return found || list[0];
    }

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

    function setTextAll(root, selector, text) {
        if (!root) return;
        var nodes = root.querySelectorAll(selector);
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].textContent = text;
        }
    }

    function populateCard(trail, card) {
        if (!trail || !card) return;

        setTextAll(card, '.map-place-card__title', trail.title || '');
        setTextAll(card, '.map-place-card__kicker', trail.locationLabel || '');

        var loc = trail.locations || {};
        var postal = loc.postalAddress || '';
        setTextAll(card, '.map-place-card__postal', postal);
        card.querySelectorAll('.map-place-card__postal').forEach(function (el) {
            if (el) el.hidden = !postal;
        });

        var detailEl = card.querySelector('.map-place-card__detail--mobile');
        if (detailEl) detailEl.textContent = trail.detail || '';

        var imgEl = card.querySelector('.map-place-card__img');
        if (imgEl && trail.thumb) {
            if (trail.thumb.src) imgEl.src = trail.thumb.src;
            if (trail.thumb.alt != null) imgEl.alt = trail.thumb.alt;
        }

        var gallery = trail.gallery && trail.gallery.length ? trail.gallery : trail.thumb ? [trail.thumb] : [];
        var mainG = card.querySelector('.map-place-card__gallery-main');
        var subs = card.querySelectorAll('.map-place-card__gallery-sub');
        if (mainG && gallery[0]) {
            mainG.src = gallery[0].src || '';
            mainG.alt = gallery[0].alt != null ? gallery[0].alt : trail.title || '';
        }
        for (var g = 0; g < subs.length; g++) {
            var idx = g + 1;
            var item = gallery[idx] || gallery[0];
            if (item && subs[g]) {
                subs[g].src = item.src || '';
                subs[g].alt = item.alt != null ? item.alt : trail.title || '';
            }
        }

        var metrics = trail.metrics || {};
        var dds = card.querySelectorAll('[data-map-metric]');
        for (var d = 0; d < dds.length; d++) {
            var dd = dds[d];
            var mkey = dd.getAttribute('data-map-metric');
            var mval = metrics[mkey];
            dd.textContent = mval != null && mval !== '' ? mval : '—';
        }

        var descEl = card.querySelector('.map-place-card__description');
        if (descEl) descEl.textContent = trail.description || '';

        var more = card.querySelector('.map-place-card__more');
        if (more && trail.moreDetailsHref) {
            more.setAttribute('href', trail.moreDetailsHref);
        }
    }

    function applyDirectionsAll(root, destination) {
        if (!root || !destination) return;
        var url =
            'https://www.google.com/maps/dir/?api=1&destination=' +
            encodeURIComponent(destination);
        root.querySelectorAll('.js-map-directions').forEach(function (a) {
            a.href = url;
        });
    }

    /** When map.json lists exactly one trail, keep a single title/kicker in the DOM (moved between layouts). */
    function initTrailHeadingPlacement(card, trailCount) {
        if (trailCount !== 1) return;
        var heading = document.getElementById('map-place-trail-heading');
        var am = document.getElementById('map-place-heading-anchor-mobile');
        var at = document.getElementById('map-place-heading-anchor-tablet');
        if (!heading || !am || !at) return;

        function place() {
            var wide = window.matchMedia('(min-width: 768px)').matches;
            (wide ? at : am).appendChild(heading);
        }

        place();
        window.addEventListener('resize', place);
    }

    function wireShare(trail) {
        var shareBtn = document.getElementById('map-place-share');
        if (shareBtn) {
            shareBtn.addEventListener('click', function () {
                var payload = {
                    title: trail.title || document.title,
                    url: window.location.href
                };
                if (navigator.share) {
                    navigator.share(payload).catch(function () {});
                } else if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(payload.url).catch(function () {});
                }
            });
        }
    }

    /**
     * Per-trail fit tuning (locations.mapView.layout). Same keys work for every trail — copy the block in map.json.
     * Tablet: reserves space for the left side card so fitBounds uses the visible map pane.
     */
    function getMapLayout(trail) {
        var mv = trail && trail.locations && trail.locations.mapView;
        var raw = mv && mv.layout;
        var reserveX = 400;
        var vwPct = 0.05;
        var reserveTop = 80;
        var trailPanelTop = 56;
        var overviewPad = 48;
        var trailPad = 8;
        if (raw) {
            if (raw.panelReservePx != null) reserveX = Number(raw.panelReservePx);
            if (raw.panelReserveVwPct != null) vwPct = Number(raw.panelReserveVwPct);
            if (raw.panelReserveTopPx != null) reserveTop = Number(raw.panelReserveTopPx);
            if (raw.trailFitPanelTopPx != null) trailPanelTop = Number(raw.trailFitPanelTopPx);
            if (raw.overviewEdgePaddingPx != null) overviewPad = Number(raw.overviewEdgePaddingPx);
            if (raw.trailEdgePaddingPx != null) trailPad = Number(raw.trailEdgePaddingPx);
        }
        return {
            reserveX: reserveX,
            vwPct: vwPct,
            reserveTop: reserveTop,
            trailPanelTop: trailPanelTop,
            overviewPad: overviewPad,
            trailPad: trailPad
        };
    }

    function panelInsetForOverview(trail) {
        var lo = getMapLayout(trail);
        var x = Math.round(lo.reserveX + window.innerWidth * lo.vwPct);
        return L.point(x, lo.reserveTop);
    }

    function panelInsetForTrailFit(trail) {
        var lo = getMapLayout(trail);
        var x = Math.round(lo.reserveX + window.innerWidth * lo.vwPct);
        return L.point(x, lo.trailPanelTop);
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
     * Optional exact framing: set locations.mapView.referenceView from the tuned map:
     *   map.getCenter(); map.getZoom();
     * Then paste { "center": [lat, lng], "zoom": n } — overrides fitBounds(bounds) on load.
     */
    function getReferenceView(trail) {
        var mv = trail && trail.locations && trail.locations.mapView;
        var rv = mv && mv.referenceView;
        if (!rv) return null;
        var c = rv.center;
        var z = rv.zoom;
        if (!c || c.length < 2 || z == null) return null;
        var lat = Number(c[0]);
        var lng = Number(c[1]);
        var zoom = Number(z);
        if (isNaN(lat) || isNaN(lng) || isNaN(zoom)) return null;
        return { latlng: L.latLng(lat, lng), zoom: zoom };
    }

    function getMapFitOptions(trail) {
        var lo = getMapLayout(trail);
        var fitOpts = { padding: [lo.overviewPad, lo.overviewPad], maxZoom: 16 };
        var mv = trail && trail.locations && trail.locations.mapView;
        if (mv && mv.maxZoom != null) fitOpts.maxZoom = mv.maxZoom;
        if (window.matchMedia && window.matchMedia('(min-width: 768px)').matches) {
            fitOpts.paddingTopLeft = panelInsetForOverview(trail);
        }
        return fitOpts;
    }

    /** Fit trail GeoJSON as large as possible in the map pane (minimal margin; tablet reserves side card). */
    function getTrailFitOptions(trail) {
        var mv = trail && trail.locations && trail.locations.mapView;
        var lo = getMapLayout(trail);
        var maxZ = 19;
        if (mv && mv.trailFitMaxZoom != null) {
            maxZ = Number(mv.trailFitMaxZoom);
        } else if (mv && mv.markerClickMaxZoom != null) {
            maxZ = Number(mv.markerClickMaxZoom);
        }
        if (maxZ < 1 || maxZ > 22) {
            maxZ = 19;
        }

        var pad = lo.trailPad;
        if (mv && mv.trailFitPadding != null) {
            pad = Number(mv.trailFitPadding);
        }
        if (pad < 0 || pad > 80) {
            pad = lo.trailPad;
        }

        var opts = {
            padding: [pad, pad],
            maxZoom: maxZ
        };
        if (window.matchMedia && window.matchMedia('(min-width: 768px)').matches) {
            opts.paddingTopLeft = panelInsetForTrailFit(trail);
        }
        return opts;
    }

    /** Initial camera: referenceView wins; else park bounds; else trail line. */
    function applyInitialMapView(map, trail, layer) {
        if (!map) return;
        var ref = getReferenceView(trail);
        if (ref) {
            map.setView(ref.latlng, ref.zoom);
            return;
        }
        if (getParkViewBounds(trail)) {
            fitParkView(map, trail, false);
        } else if (layer && layer.getBounds && layer.getBounds().isValid()) {
            map.fitBounds(layer.getBounds(), getTrailFitOptions(trail));
        }
    }

    /** Fit map to park overview when mapView.bounds exists; returns whether it ran. */
    function fitParkView(map, trail, animate) {
        var bounds = getParkViewBounds(trail);
        if (!bounds || !map) return false;
        var opts = getMapFitOptions(trail);
        if (animate && map.flyToBounds) {
            map.flyToBounds(bounds, opts);
        } else {
            map.fitBounds(bounds, opts);
        }
        return true;
    }

    /**
     * Marker click: zoom tighter than park overview — fit trail line if possible, else flyTo marker.
     */
    function zoomFromMarkerClick(map, trail, geoLayer, markerLatLng) {
        if (!map) return;
        var mv = trail.locations && trail.locations.mapView;

        if (geoLayer && geoLayer.getBounds && geoLayer.getBounds().isValid()) {
            var opts = getTrailFitOptions(trail);
            if (map.flyToBounds) {
                map.flyToBounds(geoLayer.getBounds(), opts);
            } else {
                map.fitBounds(geoLayer.getBounds(), opts);
            }
            return;
        }

        var z =
            mv && mv.markerClickZoom != null ? Number(mv.markerClickZoom) : 18;
        if (z < 1 || z > 22) z = 18;
        if (map.flyTo) {
            map.flyTo(markerLatLng, z);
        } else {
            map.setView(markerLatLng, z);
        }
    }

    /**
     * Trail center for camera / zoom fallback (bounds centroid → park overview → trail.marker).
     * Not shown as a map pin — only locations.addressMarker (plus fallbacks) gets a visible marker.
     */
    function getMarkerLatLng(trail, geoLayer) {
        if (geoLayer && geoLayer.getBounds && geoLayer.getBounds().isValid()) {
            return geoLayer.getBounds().getCenter();
        }
        var pb = getParkViewBounds(trail);
        if (pb && pb.isValid()) {
            return pb.getCenter();
        }
        var m = trail.marker;
        if (m && m.lat != null && m.lng != null) {
            return L.latLng(m.lat, m.lng);
        }
        return null;
    }

    var qsTrail =
        typeof URLSearchParams !== 'undefined'
            ? new URLSearchParams(window.location.search).get('trail')
            : null;

    fetch('data/map.json')
        .then(function (res) {
            return res.ok ? res.json() : Promise.reject(new Error('map.json failed'));
        })
        .then(function (config) {
            var trail = pickTrail(config, qsTrail);
            if (!trail) {
                return;
            }

            resolveTrailGeo(trail)
                .catch(function () {
                    return null;
                })
                .then(function (geo) {
                    var layer = null;
                    var lineStyle = mergeStyle(trail.style);
                    if (geo) {
                        layer = geoJsonToDoubleLineLayer(geo, lineStyle, 5);
                    }

                    var latlng = getMarkerLatLng(trail, layer);
                    if (!latlng) {
                        return;
                    }

                    var map = L.map('map', {
                        zoomControl: false,
                        attributionControl: false
                    }).setView(latlng, 13);

                    L.control.zoom({ position: 'topright' }).addTo(map);

                    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                        maxZoom: 19,
                        attribution: ''
                    }).addTo(map);

                    var card = document.getElementById('map-place-card');

                    populateCard(trail, card);
                    var directionsTarget =
                        trail.locations && trail.locations.directions
                            ? trail.locations.directions
                            : trail.directionsDestination;
                    applyDirectionsAll(card, directionsTarget);
                    wireShare(trail);
                    initTrailHeadingPlacement(card, config.trails ? config.trails.length : 0);

                    var trailCenterLatLng = latlng;

                    var locForPin = trail.locations || {};
                    /** Visible marker only — postal/directions point (same idea as card). Fallbacks keep a pin if coords omitted. */
                    var addressLatLng =
                        locForPin.addressMarker &&
                        locForPin.addressMarker.lat != null &&
                        locForPin.addressMarker.lng != null
                            ? L.latLng(locForPin.addressMarker.lat, locForPin.addressMarker.lng)
                            : trail.marker && trail.marker.lat != null && trail.marker.lng != null
                              ? L.latLng(trail.marker.lat, trail.marker.lng)
                              : trailCenterLatLng;

                    var connectorLayer = null;
                    /** When true, skip drawing trail overlays until zoom/pan settles (marker open). */
                    var deferTrailRevealUntilZoom = false;
                    var trailRevealMoveEndHandler = null;

                    function detachTrailRevealOnMoveEnd() {
                        if (trailRevealMoveEndHandler && map) {
                            map.off('moveend', trailRevealMoveEndHandler);
                            trailRevealMoveEndHandler = null;
                        }
                    }

                    /** After flyToBounds / zoom, reveal the path on the next moveend Leaflet emits. */
                    function scheduleTrailRevealAfterZoom() {
                        detachTrailRevealOnMoveEnd();
                        trailRevealMoveEndHandler = function onTrailRevealMoveEnd() {
                            detachTrailRevealOnMoveEnd();
                            deferTrailRevealUntilZoom = false;
                            syncTrailVisibility();
                        };
                        map.on('moveend', trailRevealMoveEndHandler);
                    }

                    function syncTrailVisibility() {
                        if (!map || !card) return;
                        var cardOpen = card.classList.contains('is-open');
                        /* Hide path while flying to bounds so the route appears once framing finishes. */
                        var showTrail = cardOpen && !(deferTrailRevealUntilZoom && layer);
                        if (showTrail) {
                            if (layer && !map.hasLayer(layer)) {
                                layer.addTo(map);
                            }
                            if (connectorLayer && !map.hasLayer(connectorLayer)) {
                                connectorLayer.addTo(map);
                            }
                        } else {
                            if (connectorLayer && map.hasLayer(connectorLayer)) {
                                map.removeLayer(connectorLayer);
                            }
                            if (layer && map.hasLayer(layer)) {
                                map.removeLayer(layer);
                            }
                        }
                    }

                    var marker = L.marker(addressLatLng).addTo(map);

                    function openCard() {
                        if (!card) return;
                        card.classList.add('is-open');
                        card.setAttribute('aria-hidden', 'false');
                        syncTrailVisibility();
                    }

                    function closeCard() {
                        if (!card) return;
                        detachTrailRevealOnMoveEnd();
                        deferTrailRevealUntilZoom = false;
                        card.classList.remove('is-open');
                        card.setAttribute('aria-hidden', 'true');
                        syncTrailVisibility();
                    }

                    document.querySelectorAll('.js-map-place-close').forEach(function (btn) {
                        btn.addEventListener('click', function (ev) {
                            ev.preventDefault();
                            ev.stopPropagation();
                            closeCard();
                        });
                    });

                    marker.on('click', function (ev) {
                        L.DomEvent.stopPropagation(ev);
                        detachTrailRevealOnMoveEnd();
                        deferTrailRevealUntilZoom = !!layer;
                        openCard();
                        /* Listen before triggering fly/zoom so a synchronous moveend is not skipped. */
                        if (deferTrailRevealUntilZoom) {
                            scheduleTrailRevealAfterZoom();
                        }
                        zoomFromMarkerClick(map, trail, layer, latlng);
                    });

                    map.on('click', function () {
                        closeCard();
                    });

                    applyInitialMapView(map, trail, layer);
                    syncTrailVisibility();

                    resolveAccessRouteLayer(trail).then(function (lyr) {
                        connectorLayer = lyr;
                        syncTrailVisibility();
                    });
                });
        })
        .catch(function () {});
})();

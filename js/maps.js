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

    /** Park/area label for UI (prefer over internal route `title`). */
    function trailDisplayName(trail) {
        if (!trail) return '';
        return trail.locationLabel || trail.title || '';
    }

    function isWideMapStrip() {
        return typeof window.matchMedia !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
    }

    /** Compact strip on tablet/desktop: length · estimated time only (no street address). */
    function stripSummaryLine(trail) {
        if (!trail) return '';
        var m = trail.metrics || {};
        var parts = [];
        if (m.length) parts.push(m.length);
        if (m.estimatedTime) {
            var et = String(m.estimatedTime).trim();
            parts.push(/^est\./i.test(et) ? et : 'Est. ' + et);
        }
        return parts.join(' · ');
    }

    function updateStripDetailLine(trail, card) {
        if (!trail || !card) return;
        var detailEl = card.querySelector('.map-place-card__detail--mobile');
        if (!detailEl) return;
        detailEl.textContent = isWideMapStrip() ? stripSummaryLine(trail) || trail.detail || '' : trail.detail || '';
    }

    function populateCard(trail, card) {
        if (!trail || !card) return;

        var displayName = trailDisplayName(trail);
        var modal = document.getElementById('map-place-mobile-modal');
        var roots = modal ? [card, modal] : [card];

        roots.forEach(function (root) {
            setTextAll(root, '.map-place-card__title', displayName);
        });

        updateStripDetailLine(trail, card);

        var diffWrap = card.querySelector('[data-map-strip-difficulty-wrap]');
        var diffLabel = card.querySelector('.map-place-card__difficulty-label');
        var diffSep = card.querySelector('[data-map-strip-difficulty-sep]');
        if (diffWrap && diffLabel) {
            var diff = trail.difficultyLabel;
            if (diff) {
                diffWrap.hidden = false;
                diffLabel.textContent = diff;
                if (diffSep) diffSep.hidden = false;
            } else {
                diffWrap.hidden = true;
                if (diffSep) diffSep.hidden = true;
            }
        }

        var imgEl = card.querySelector('.map-place-card__img');
        if (imgEl && trail.thumb) {
            if (trail.thumb.src) imgEl.src = trail.thumb.src;
            if (trail.thumb.alt != null) imgEl.alt = trail.thumb.alt;
        }

        var gallery = trail.gallery && trail.gallery.length ? trail.gallery : trail.thumb ? [trail.thumb] : [];
        roots.forEach(function (root) {
            root.querySelectorAll('.map-place-card__gallery-main').forEach(function (mainG) {
                if (mainG && gallery[0]) {
                    mainG.src = gallery[0].src || '';
                    mainG.alt = gallery[0].alt != null ? gallery[0].alt : displayName;
                }
            });
        });
        var subs = [];
        roots.forEach(function (root) {
            root.querySelectorAll('.map-place-card__gallery-sub').forEach(function (el) {
                subs.push(el);
            });
        });
        for (var g = 0; g < subs.length; g++) {
            var idx = g + 1;
            var item = gallery[idx] || gallery[0];
            if (item && subs[g]) {
                subs[g].src = item.src || '';
                subs[g].alt = item.alt != null ? item.alt : displayName;
            }
        }

        var metrics = trail.metrics || {};
        roots.forEach(function (root) {
            var dds = root.querySelectorAll('[data-map-metric]');
            for (var d = 0; d < dds.length; d++) {
                var dd = dds[d];
                var mkey = dd.getAttribute('data-map-metric');
                var mval = metrics[mkey];
                dd.textContent = mval != null && mval !== '' ? mval : '—';
            }
        });

        roots.forEach(function (root) {
            var descEl = root.querySelector('.map-place-card__description');
            if (descEl) descEl.textContent = trail.description || '';
        });

        var heroModal = modal && modal.querySelector('.map-place-detail__hero-img');
        if (heroModal && gallery[0]) {
            heroModal.src = gallery[0].src || '';
            heroModal.alt = gallery[0].alt != null ? gallery[0].alt : displayName;
        }

        populateMobileDetailFields(trail);
        setupMobileDetailInteractions(trail);
        initMapPlaceWeather(trail);
    }

    function getForecastCoords(trail) {
        if (!trail) return null;
        var loc = trail.locations || {};
        if (loc.addressMarker && loc.addressMarker.lat != null && loc.addressMarker.lng != null) {
            return { lat: Number(loc.addressMarker.lat), lng: Number(loc.addressMarker.lng) };
        }
        if (trail.marker && trail.marker.lat != null && trail.marker.lng != null) {
            return { lat: Number(trail.marker.lat), lng: Number(trail.marker.lng) };
        }
        return null;
    }

    /** WMO weather interpretation codes (Open-Meteo). */
    function weatherCodeMeta(code) {
        var c = code == null ? -1 : Number(code);
        if (c === 0) {
            return { label: 'Clear', variant: 'clear' };
        }
        if (c >= 1 && c <= 3) {
            return { label: c === 1 ? 'Mostly clear' : c === 2 ? 'Partly cloudy' : 'Overcast', variant: 'partly' };
        }
        if (c >= 45 && c <= 48) {
            return { label: 'Foggy', variant: 'fog' };
        }
        if (c >= 51 && c <= 57) {
            return { label: 'Drizzle', variant: 'drizzle' };
        }
        if ((c >= 61 && c <= 67) || c === 80 || c === 81 || c === 82) {
            return { label: c >= 80 && c <= 82 ? 'Rain showers' : 'Rain', variant: 'rain' };
        }
        if (c >= 71 && c <= 77) {
            return { label: 'Snow', variant: 'snow' };
        }
        if (c >= 95 && c <= 99) {
            return { label: 'Thunderstorm', variant: 'storm' };
        }
        return { label: 'Cloudy', variant: 'cloud' };
    }

    function weatherSvg(variant, size) {
        var s = size || 24;
        var vb = '0 0 24 24';
        var inner;
        switch (variant) {
            case 'clear':
                inner =
                    '<circle cx="12" cy="12" r="5" fill="#fbbf24" stroke="#f59e0b" stroke-width="1"/>' +
                    '<g stroke="#fbbf24" stroke-width="1.5" stroke-linecap="round">' +
                    '<line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/>' +
                    '<line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/>' +
                    '<line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>' +
                    '<line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></g>';
                break;
            case 'partly':
                inner =
                    '<circle cx="8" cy="9" r="3.5" fill="#fbbf24"/>' +
                    '<path fill="#94a3b8" d="M14 18a4 4 0 0 1-3.9-3.2 3.5 3.5 0 1 1 3.4-4.3A4 4 0 0 1 14 18z"/>';
                break;
            case 'fog':
                inner =
                    '<path fill="#94a3b8" d="M6 14h12v1.5H6V14zm0-3h10v1.5H6V11zm2-3h8v1.5H8V8z"/>' +
                    '<path fill="#cbd5e1" d="M5 17h14v1H5v-1z"/>';
                break;
            case 'drizzle':
            case 'rain':
            case 'storm':
                inner =
                    '<path fill="#94a3b8" d="M8 6a4 4 0 0 1 7.7-1A4 4 0 0 1 17 13H8a4 4 0 0 1 0-8 2 2 0 0 1 0-4z"/>' +
                    '<path stroke="#38bdf8" stroke-width="1.6" stroke-linecap="round" fill="none" d="M9 15v2.5M12 14v2.5M15 15v2.5"/>';
                if (variant === 'storm') {
                    inner +=
                        '<path fill="#f59e0b" d="M12 16l-1.2 2.5h2l-1 2.8 2.8-3.2h-1.8l.9-2.1z"/>';
                }
                break;
            case 'snow':
                inner =
                    '<path fill="#94a3b8" d="M8 6a4 4 0 0 1 7.7-1A4 4 0 0 1 17 13H8a4 4 0 0 1 0-8 2 2 0 0 1 0-4z"/>' +
                    '<circle cx="9" cy="16" r="1" fill="#e2e8f0"/><circle cx="12" cy="18" r="1" fill="#e2e8f0"/><circle cx="15" cy="16" r="1" fill="#e2e8f0"/>';
                break;
            default:
                inner = '<path fill="#94a3b8" d="M8 7a4 4 0 0 1 7.7-1A4 4 0 0 1 17 14H7a4 4 0 0 1-.2-8 3 3 0 0 1 1.2-6z"/>';
        }
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" width="' +
            s +
            '" height="' +
            s +
            '" viewBox="' +
            vb +
            '" class="map-place-weather__svg" focusable="false" aria-hidden="true">' +
            inner +
            '</svg>'
        );
    }

    function formatShortTime(iso) {
        if (!iso || typeof iso !== 'string') return '—';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }

    function initMapPlaceWeather(trail) {
        var section = document.querySelector('[data-map-weather]');
        if (!section) return;

        var coords = getForecastCoords(trail);
        var loadEl = section.querySelector('.map-place-weather__loading');
        var inner = section.querySelector('.map-place-weather__inner');
        var errEl = section.querySelector('.map-place-weather__error');
        var tabsEl = section.querySelector('.map-place-weather__tabs');
        var detail = section.querySelector('.map-place-weather__detail');

        function resetUi() {
            if (errEl) {
                errEl.hidden = true;
                errEl.textContent = '';
            }
        }

        if (!coords) {
            section.hidden = true;
            if (loadEl) loadEl.hidden = true;
            if (inner) inner.hidden = true;
            return;
        }

        section.hidden = false;
        if (loadEl) loadEl.hidden = false;
        if (inner) inner.hidden = true;
        resetUi();

        var tz = trail.locations && trail.locations.weatherTimezone ? trail.locations.weatherTimezone : 'America/New_York';
        var url =
            'https://api.open-meteo.com/v1/forecast?latitude=' +
            encodeURIComponent(coords.lat) +
            '&longitude=' +
            encodeURIComponent(coords.lng) +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset' +
            '&temperature_unit=fahrenheit' +
            '&timezone=' +
            encodeURIComponent(tz) +
            '&forecast_days=7';

        fetch(url)
            .then(function (res) {
                return res.ok ? res.json() : Promise.reject(new Error('Weather unavailable'));
            })
            .then(function (data) {
                var daily = data && data.daily;
                if (!daily || !daily.time || !daily.time.length) {
                    throw new Error('No forecast');
                }

                var days = [];
                for (var i = 0; i < daily.time.length; i++) {
                    days.push({
                        dateStr: daily.time[i],
                        code: daily.weather_code != null ? daily.weather_code[i] : 0,
                        maxF: daily.temperature_2m_max != null ? daily.temperature_2m_max[i] : null,
                        minF: daily.temperature_2m_min != null ? daily.temperature_2m_min[i] : null,
                        pop: daily.precipitation_probability_max != null ? daily.precipitation_probability_max[i] : null,
                        sunrise: daily.sunrise != null ? daily.sunrise[i] : '',
                        sunset: daily.sunset != null ? daily.sunset[i] : ''
                    });
                }

                var selected = 0;

                function dayTabLabel(dateStr) {
                    var d = new Date(dateStr + 'T12:00:00');
                    if (isNaN(d.getTime())) return '';
                    var today = new Date();
                    if (
                        d.getFullYear() === today.getFullYear() &&
                        d.getMonth() === today.getMonth() &&
                        d.getDate() === today.getDate()
                    ) {
                        return 'Today';
                    }
                    return d.toLocaleDateString('en-US', { weekday: 'short' });
                }

                function renderDetail() {
                    var day = days[selected];
                    if (!day || !detail) return;

                    var meta = weatherCodeMeta(day.code);
                    var condIcon = detail.querySelector('.map-place-weather__condition-icon');
                    var condLabel = detail.querySelector('.map-place-weather__condition-label');
                    var hi = detail.querySelector('.map-place-weather__high');
                    var lo = detail.querySelector('.map-place-weather__low');
                    var precip = detail.querySelector('.map-place-weather__precip');
                    var sr = detail.querySelector('.map-place-weather__sunrise');
                    var ss = detail.querySelector('.map-place-weather__sunset');

                    if (condIcon) {
                        condIcon.innerHTML = weatherSvg(meta.variant, 44);
                    }
                    if (condLabel) condLabel.textContent = meta.label;

                    var h = day.maxF != null && !isNaN(Number(day.maxF)) ? Math.round(Number(day.maxF)) : '—';
                    var l = day.minF != null && !isNaN(Number(day.minF)) ? Math.round(Number(day.minF)) : '—';
                    if (hi) hi.textContent = typeof h === 'number' ? h + '°' : h;
                    if (lo) lo.textContent = typeof l === 'number' ? l + '°' : l;

                    if (precip) {
                        var p = day.pop != null && !isNaN(Number(day.pop)) ? Math.round(Number(day.pop)) : null;
                        precip.textContent = p != null ? p + '%' : '—';
                    }
                    if (sr) {
                        sr.textContent = formatShortTime(day.sunrise);
                        if (day.sunrise) sr.setAttribute('datetime', day.sunrise);
                        else sr.removeAttribute('datetime');
                    }
                    if (ss) {
                        ss.textContent = formatShortTime(day.sunset);
                        if (day.sunset) ss.setAttribute('datetime', day.sunset);
                        else ss.removeAttribute('datetime');
                    }
                }

                function selectTab(index) {
                    selected = index;
                    if (!tabsEl) return;
                    var buttons = tabsEl.querySelectorAll('.map-place-weather__tab');
                    for (var b = 0; b < buttons.length; b++) {
                        var isSel = b === selected;
                        buttons[b].setAttribute('aria-selected', isSel ? 'true' : 'false');
                        buttons[b].classList.toggle('is-selected', isSel);
                        buttons[b].tabIndex = isSel ? 0 : -1;
                    }
                    var panel = document.getElementById('map-place-weather-panel');
                    if (panel) {
                        panel.setAttribute('aria-labelledby', 'map-weather-tab-' + selected);
                    }
                    renderDetail();
                }

                if (tabsEl) {
                    tabsEl.innerHTML = '';
                    days.forEach(function (day, idx) {
                        var meta = weatherCodeMeta(day.code);
                        var btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'map-place-weather__tab';
                        btn.setAttribute('role', 'tab');
                        btn.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
                        btn.id = 'map-weather-tab-' + idx;
                        btn.tabIndex = idx === 0 ? 0 : -1;
                        btn.innerHTML =
                            '<span class="map-place-weather__tab-day">' +
                            dayTabLabel(day.dateStr) +
                            '</span><span class="map-place-weather__tab-icon">' +
                            weatherSvg(meta.variant, 22) +
                            '</span>';
                        btn.addEventListener('click', function () {
                            selectTab(idx);
                        });
                        tabsEl.appendChild(btn);
                    });
                }

                selectTab(0);

                if (loadEl) loadEl.hidden = true;
                if (inner) inner.hidden = false;
            })
            .catch(function () {
                if (loadEl) loadEl.hidden = true;
                if (inner) inner.hidden = true;
                if (errEl) {
                    errEl.hidden = false;
                    errEl.textContent = 'Weather could not be loaded. Try again later.';
                }
            });
    }

    /** Breadcrumbs, difficulty row, park link, photo dots (mobile modal). Mini map: Leaflet in main init. */
    function populateMobileDetailFields(trail) {
        var modal = document.getElementById('map-place-mobile-modal');
        if (!modal || !trail) return;

        var bc = modal.querySelector('.map-place-detail__breadcrumbs');
        if (bc) {
            var bt = trail.breadcrumbs || '';
            bc.textContent = bt;
            bc.hidden = !String(bt).trim();
        }

        var diffWrap = modal.querySelector('.map-place-detail__difficulty-wrap');
        var diffLabel = modal.querySelector('.map-place-detail__difficulty-label');
        if (diffWrap && diffLabel) {
            if (trail.difficultyLabel) {
                diffWrap.hidden = false;
                diffLabel.textContent = trail.difficultyLabel;
            } else {
                diffWrap.hidden = true;
            }
        }

        var parkLink = modal.querySelector('.map-place-detail__park-link--standalone');
        if (parkLink) {
            if (trail.locationLabel) {
                parkLink.hidden = false;
                parkLink.textContent = trail.locationLabel;
                var q =
                    trail.locations && trail.locations.directions
                        ? trail.locations.directions
                        : trail.locationLabel;
                parkLink.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
                parkLink.target = '_blank';
                parkLink.rel = 'noopener noreferrer';
            } else {
                parkLink.hidden = true;
            }
        }
    }

    function stopMapHeroGalleryAutoplay(modalEl) {
        var modal = modalEl || document.getElementById('map-place-mobile-modal');
        if (!modal) return;
        var tid = modal.getAttribute('data-hero-gallery-autoplay-id');
        if (tid != null && tid !== '') {
            clearInterval(Number(tid));
            modal.removeAttribute('data-hero-gallery-autoplay-id');
        }
    }

    function setupMobileDetailInteractions(trail) {
        var modal = document.getElementById('map-place-mobile-modal');
        if (!modal || !trail) return;

        stopMapHeroGalleryAutoplay(modal);

        var gallery =
            trail.gallery && trail.gallery.length ? trail.gallery : trail.thumb ? [trail.thumb] : [];
        var heroImg = modal.querySelector('.map-place-detail__hero-img');
        var heroImgWrap = modal.querySelector('.js-map-detail-gallery-open');
        var galleryPrevBtn = modal.querySelector('.js-map-detail-gallery-prev');
        var galleryNextBtn = modal.querySelector('.js-map-detail-gallery-next');
        var dots = modal.querySelector('.map-place-detail__photo-dots');
        var heroSection = modal.querySelector('.map-place-detail__hero');

        if (galleryPrevBtn && galleryNextBtn) {
            var showGalleryNav = gallery.length > 1;
            galleryPrevBtn.hidden = !showGalleryNav;
            galleryNextBtn.hidden = !showGalleryNav;
        }
        var currentIdx = 0;
        var galleryAutoplayMs = 12000;
        var heroImgAnimBusy = false;
        var heroImgAnimQueued = null;

        function applyModalHeroDots(i) {
            if (dots) {
                var all = dots.querySelectorAll('.map-place-detail__dot');
                for (var j = 0; j < all.length; j++) {
                    all[j].classList.toggle('is-active', j === i);
                }
            }
            if (heroImgWrap && gallery.length) {
                heroImgWrap.setAttribute(
                    'aria-label',
                    gallery.length > 1
                        ? 'Open photo ' + (i + 1) + ' of ' + gallery.length + ' full size'
                        : 'View photo full size'
                );
            }
        }

        function applyModalHeroPhotoInstant(i) {
            var item = gallery[i];
            currentIdx = i;
            heroImg.src = item.src || '';
            heroImg.alt = item.alt != null ? item.alt : trailDisplayName(trail);
            heroImg.style.opacity = '1';
            applyModalHeroDots(i);
        }

        function drainHeroImgAnimQueue() {
            heroImgAnimBusy = false;
            if (heroImgAnimQueued == null) return;
            var next = heroImgAnimQueued;
            heroImgAnimQueued = null;
            if (next !== currentIdx) {
                showModalHeroPhoto(next);
            }
        }

        function runModalHeroPhotoFade(i) {
            heroImgAnimBusy = true;
            heroImg.style.opacity = '0';

            function onFadeOut(ev) {
                if (ev.propertyName !== 'opacity') return;
                var item = gallery[i];
                currentIdx = i;
                heroImg.alt = item.alt != null ? item.alt : trailDisplayName(trail);
                heroImg.src = item.src || '';
                applyModalHeroDots(i);

                function fadeIn() {
                    function onFadeIn(ev2) {
                        if (ev2.propertyName !== 'opacity') return;
                        heroImg.removeEventListener('transitionend', onFadeIn);
                        drainHeroImgAnimQueue();
                    }

                    heroImg.addEventListener('transitionend', onFadeIn, { passive: true });

                    requestAnimationFrame(function () {
                        heroImg.style.opacity = '1';
                    });
                }

                if (heroImg.complete && heroImg.naturalWidth > 0) {
                    requestAnimationFrame(fadeIn);
                } else {
                    heroImg.addEventListener(
                        'load',
                        function () {
                            requestAnimationFrame(fadeIn);
                        },
                        { once: true }
                    );
                    heroImg.addEventListener(
                        'error',
                        function () {
                            requestAnimationFrame(fadeIn);
                        },
                        { once: true }
                    );
                }
            }

            heroImg.addEventListener('transitionend', onFadeOut, { once: true, passive: true });
        }

        function showModalHeroPhoto(index) {
            if (!heroImg || !gallery.length) return;
            var n = gallery.length;
            var i = ((index % n) + n) % n;

            var reduceMotion =
                window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

            if (reduceMotion || n <= 1) {
                heroImgAnimQueued = null;
                heroImgAnimBusy = false;
                applyModalHeroPhotoInstant(i);
                return;
            }

            if (i === currentIdx && !heroImgAnimBusy && heroImg.style.opacity !== '0') {
                return;
            }

            if (heroImgAnimBusy) {
                heroImgAnimQueued = i;
                return;
            }

            runModalHeroPhotoFade(i);
        }

        function startMapHeroGalleryAutoplay() {
            stopMapHeroGalleryAutoplay(modal);
            if (gallery.length <= 1 || !heroImg) return;
            if (
                window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ) {
                return;
            }
            var autoplayId = setInterval(function () {
                showModalHeroPhoto(currentIdx + 1);
            }, galleryAutoplayMs);
            modal.setAttribute('data-hero-gallery-autoplay-id', String(autoplayId));
        }

        modal._mapHeroGalleryStartAutoplay = startMapHeroGalleryAutoplay;

        function openDetailGalleryFullscreen() {
            if (!gallery.length) return;
            var displayName = trailDisplayName(trail);
            var elems = [];
            for (var gi = 0; gi < gallery.length; gi++) {
                var gitem = gallery[gi];
                if (!gitem || !gitem.src) continue;
                elems.push({
                    href: gitem.src,
                    type: 'image',
                    title: displayName,
                    alt: gitem.alt != null ? gitem.alt : displayName
                });
            }
            if (!elems.length) return;

            var startIdx = Math.min(Math.max(0, currentIdx), elems.length - 1);

            if (typeof GLightbox !== 'undefined') {
                var lb = GLightbox({
                    elements: elems,
                    loop: elems.length > 1,
                    touchNavigation: true,
                    zoomable: true
                });
                if (typeof lb.openAt === 'function') {
                    lb.openAt(startIdx);
                } else {
                    lb.open();
                }
            } else {
                var cur = gallery[startIdx];
                if (cur && cur.src) {
                    window.open(cur.src, '_blank', 'noopener,noreferrer');
                }
            }
        }

        modal._mapDetailGalleryControl = {
            prev: function () {
                showModalHeroPhoto(currentIdx - 1);
                startMapHeroGalleryAutoplay();
            },
            next: function () {
                showModalHeroPhoto(currentIdx + 1);
                startMapHeroGalleryAutoplay();
            },
            open: openDetailGalleryFullscreen
        };

        if (!modal.dataset.mapDetailGalleryChromeWired) {
            modal.dataset.mapDetailGalleryChromeWired = '1';
            modal.addEventListener('click', function (ev) {
                var ctl = modal._mapDetailGalleryControl;
                if (!ctl) return;
                if (ev.target.closest('.js-map-detail-gallery-prev')) {
                    ev.preventDefault();
                    ctl.prev();
                    return;
                }
                if (ev.target.closest('.js-map-detail-gallery-next')) {
                    ev.preventDefault();
                    ctl.next();
                    return;
                }
                if (ev.target.closest('.js-map-detail-gallery-open')) {
                    ev.preventDefault();
                    ctl.open();
                }
            });
            modal.addEventListener('keydown', function (ev) {
                if (ev.key !== 'Enter' && ev.key !== ' ') return;
                var wrap = ev.target.closest('.js-map-detail-gallery-open');
                if (!wrap || !modal.contains(wrap)) return;
                ev.preventDefault();
                var ctlK = modal._mapDetailGalleryControl;
                if (ctlK) ctlK.open();
            });
        }

        if (dots) {
            dots.hidden = gallery.length <= 1;
            dots.innerHTML = '';
            gallery.forEach(function (item, i) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'map-place-detail__dot' + (i === 0 ? ' is-active' : '');
                b.setAttribute('aria-label', 'Photo ' + (i + 1) + ' of ' + gallery.length);
                b.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    showModalHeroPhoto(i);
                    startMapHeroGalleryAutoplay();
                });
                dots.appendChild(b);
            });
            applyModalHeroDots(0);
        } else if (gallery.length) {
            applyModalHeroDots(0);
        }

        /* Full-page mobile modal only: swipe hero photo left/right (not tablet strip/gallery). */
        if (
            heroSection &&
            gallery.length > 1 &&
            !heroSection.dataset.modalHeroSwipeWired
        ) {
            heroSection.dataset.modalHeroSwipeWired = '1';
            var startX = 0;
            var startY = 0;
            var tracking = false;
            var SWIPE_PX = 40;

            function shouldIgnoreSwipeTarget(t) {
                if (!t || !t.closest) return true;
                if (t.closest('button')) return true;
                if (t.closest('a[href]')) return true;
                if (t.closest('.map-place-detail__mini-map-wrap')) return true;
                return false;
            }

            heroSection.addEventListener(
                'touchstart',
                function (ev) {
                    if (ev.touches.length !== 1) return;
                    if (shouldIgnoreSwipeTarget(ev.target)) return;
                    var t = ev.touches[0];
                    startX = t.clientX;
                    startY = t.clientY;
                    tracking = true;
                },
                { passive: true }
            );

            heroSection.addEventListener(
                'touchend',
                function (ev) {
                    if (!tracking) return;
                    tracking = false;
                    if (!ev.changedTouches || !ev.changedTouches.length) return;
                    var t = ev.changedTouches[0];
                    var dx = t.clientX - startX;
                    var dy = t.clientY - startY;
                    if (Math.abs(dx) < SWIPE_PX) return;
                    if (Math.abs(dx) < Math.abs(dy)) return;
                    if (dx < 0) {
                        showModalHeroPhoto(currentIdx + 1);
                    } else {
                        showModalHeroPhoto(currentIdx - 1);
                    }
                    startMapHeroGalleryAutoplay();
                },
                { passive: true }
            );

            heroSection.addEventListener(
                'touchcancel',
                function () {
                    tracking = false;
                },
                { passive: true }
            );
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

    /**
     * Single #map-place-trail-heading moves between mobile strip, full-page mobile modal, and tablet panel.
     */
    function initTrailHeadingPlacement(card, trailCount) {
        if (trailCount !== 1) return function () {};
        var heading = document.getElementById('map-place-trail-heading');
        var am = document.getElementById('map-place-heading-anchor-mobile');
        var amModal = document.getElementById('map-place-heading-anchor-mobile-modal');
        var at = document.getElementById('map-place-heading-anchor-tablet');
        var modalEl = document.getElementById('map-place-mobile-modal');
        if (!heading || !am || !at || !amModal) return function () {};

        function place() {
            var wide = window.matchMedia('(min-width: 768px)').matches;
            if (wide) {
                if (card.classList.contains('is-detail-modal-open')) {
                    amModal.appendChild(heading);
                } else {
                    am.appendChild(heading);
                }
                return;
            }
            if (card.classList.contains('is-detail-modal-open')) {
                amModal.appendChild(heading);
            } else {
                am.appendChild(heading);
            }
        }

        place();
        window.addEventListener('resize', place);
        return place;
    }

    function wireShare(trail) {
        document.querySelectorAll('.js-map-place-share').forEach(function (shareBtn) {
            shareBtn.addEventListener('click', function () {
                var payload = {
                    title: trailDisplayName(trail) || document.title,
                    url: window.location.href
                };
                if (navigator.share) {
                    navigator.share(payload).catch(function () {});
                } else if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(payload.url).catch(function () {});
                }
            });
        });
    }

    /**
     * Per-trail fit tuning (locations.mapView.layout). Same keys work for every trail — copy the block in map.json.
     * Phone: extra bottom inset so fitBounds doesn’t frame the route/marker under the bottom sheet.
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
        /** Space to leave above the bottom edge on narrow viewports (strip card + safe area). */
        var mobileTrailFitBottomPx = 180;
        if (raw) {
            if (raw.panelReservePx != null) reserveX = Number(raw.panelReservePx);
            if (raw.panelReserveVwPct != null) vwPct = Number(raw.panelReserveVwPct);
            if (raw.panelReserveTopPx != null) reserveTop = Number(raw.panelReserveTopPx);
            if (raw.trailFitPanelTopPx != null) trailPanelTop = Number(raw.trailFitPanelTopPx);
            if (raw.overviewEdgePaddingPx != null) overviewPad = Number(raw.overviewEdgePaddingPx);
            if (raw.trailEdgePaddingPx != null) trailPad = Number(raw.trailEdgePaddingPx);
            if (raw.mobileTrailFitBottomPx != null) mobileTrailFitBottomPx = Number(raw.mobileTrailFitBottomPx);
        }
        return {
            reserveX: reserveX,
            vwPct: vwPct,
            reserveTop: reserveTop,
            trailPanelTop: trailPanelTop,
            overviewPad: overviewPad,
            trailPad: trailPad,
            mobileTrailFitBottomPx: mobileTrailFitBottomPx
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
        return fitOpts;
    }

    /**
     * Fit trail GeoJSON as large as possible (strip card may sit above marker; generous bottom inset).
     */
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

        var mb = lo.mobileTrailFitBottomPx;
        if (mb == null || isNaN(mb) || mb < 80) mb = 180;
        return {
            maxZoom: maxZ,
            paddingTopLeft: L.point(pad, pad),
            paddingBottomRight: L.point(pad, mb)
        };
    }

    /**
     * Widen trail bounds before fitBounds so the route isn’t framed edge-to-edge.
     * Set locations.mapView.trailFitBoundsPadRatio (e.g. 0.05 = 5% margin on each side → slightly less zoomed in).
     */
    function padBoundsForTrailFit(bounds, trail) {
        if (!bounds || !bounds.isValid || !bounds.isValid()) {
            return bounds;
        }
        var mv = trail && trail.locations && trail.locations.mapView;
        var ratio = mv && mv.trailFitBoundsPadRatio != null ? Number(mv.trailFitBoundsPadRatio) : NaN;
        if (isNaN(ratio) || ratio <= 0 || ratio > 0.5 || typeof bounds.pad !== 'function') {
            return bounds;
        }
        return bounds.pad(ratio);
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
            map.fitBounds(padBoundsForTrailFit(layer.getBounds(), trail), getTrailFitOptions(trail));
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
                    var mapShell = card.closest('.map-shell');
                    applyDirectionsAll(mapShell || card, directionsTarget);
                    wireShare(trail);
                    var placeHeading = initTrailHeadingPlacement(card, config.trails ? config.trails.length : 0);

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

                    function syncTrailVisibility() {
                        if (!map || !card) return;
                        var cardOpen = card.classList.contains('is-open');
                        var showTrail = cardOpen;
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

                    var DOCK_GAP_PX = 14;

                    function updateCardDockPosition() {
                        if (!card || !map || !marker) return;

                        var dockToMarkerWide =
                            window.matchMedia && window.matchMedia('(min-width: 768px)').matches;

                        function applyDockBottom() {
                            if (!map || !marker || !card) return;
                            var pt = map.latLngToContainerPoint(marker.getLatLng());
                            var sz = map.getSize();
                            var raw = sz.y - pt.y + DOCK_GAP_PX;
                            if (!isFinite(raw)) return;
                            raw = Math.max(48, Math.min(raw, sz.y - 16));
                            card.style.setProperty('--map-card-dock-bottom', raw + 'px');
                        }

                        if (!dockToMarkerWide) {
                            card.style.removeProperty('--map-card-dock-bottom');
                            return;
                        }

                        if (card.classList.contains('is-open')) {
                            applyDockBottom();
                            requestAnimationFrame(function () {
                                requestAnimationFrame(function () {
                                    applyDockBottom();
                                });
                            });
                        } else {
                            card.style.removeProperty('--map-card-dock-bottom');
                        }
                    }

                    var mobileModal = document.getElementById('map-place-mobile-modal');

                    /** Small Leaflet preview in the mobile detail hero — same trail GeoJSON as the main map (no screenshot). */
                    var detailMiniMap = null;
                    var detailMiniTrailLayer = null;

                    function fitDetailMiniMapToTrail() {
                        if (!detailMiniMap || !detailMiniTrailLayer) return;
                        var b = detailMiniTrailLayer.getBounds();
                        if (!b.isValid()) return;
                        var mv = trail.locations && trail.locations.mapView;
                        var maxZ = 17;
                        if (mv && mv.maxZoom != null) {
                            maxZ = Math.min(Number(mv.maxZoom), 17);
                        }
                        detailMiniMap.fitBounds(padBoundsForTrailFit(b, trail), {
                            padding: [8, 8],
                            maxZoom: maxZ
                        });
                    }

                    function refreshDetailMiniMapInModal() {
                        var wrap = document.querySelector('.map-place-detail__mini-map-wrap');
                        var el = document.getElementById('map-place-detail-mini-map');
                        if (!wrap || !el) return;

                        var wideDetail =
                            window.matchMedia && window.matchMedia('(min-width: 768px)').matches;

                        if (!geo || wideDetail) {
                            wrap.hidden = true;
                            return;
                        }

                        wrap.hidden = false;

                        if (!detailMiniMap) {
                            detailMiniMap = L.map(el, {
                                zoomControl: false,
                                attributionControl: false,
                                dragging: false,
                                touchZoom: false,
                                scrollWheelZoom: false,
                                doubleClickZoom: false,
                                boxZoom: false,
                                keyboard: false,
                                tap: false
                            });
                            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                                maxZoom: 19,
                                attribution: ''
                            }).addTo(detailMiniMap);
                            detailMiniTrailLayer = geoJsonToDoubleLineLayer(
                                geo,
                                mergeStyle(trail.style),
                                5
                            ).addTo(detailMiniMap);
                            fitDetailMiniMapToTrail();
                        }

                        requestAnimationFrame(function () {
                            requestAnimationFrame(function () {
                                if (!detailMiniMap) return;
                                detailMiniMap.invalidateSize(false);
                                fitDetailMiniMapToTrail();
                            });
                        });
                    }

                    function invalidateMainMapSize() {
                        requestAnimationFrame(function () {
                            if (map) {
                                map.invalidateSize(false);
                            }
                        });
                    }

                    function openMobileDetailModal() {
                        if (!card) return;
                        card.classList.add('is-detail-modal-open');
                        document.body.classList.add('map-detail-modal-open');
                        if (mobileModal) mobileModal.setAttribute('aria-hidden', 'false');
                        placeHeading();
                        refreshDetailMiniMapInModal();
                        invalidateMainMapSize();
                        updateCardDockPosition();
                        if (mobileModal && mobileModal._mapHeroGalleryStartAutoplay) {
                            mobileModal._mapHeroGalleryStartAutoplay();
                        }
                    }

                    function closeMobileDetailModal() {
                        if (!card) return;
                        stopMapHeroGalleryAutoplay(mobileModal);
                        card.classList.remove('is-detail-modal-open');
                        document.body.classList.remove('map-detail-modal-open');
                        if (mobileModal) mobileModal.setAttribute('aria-hidden', 'true');
                        placeHeading();
                        invalidateMainMapSize();
                        updateCardDockPosition();
                    }

                    var miniMapWrap = document.querySelector('.map-place-detail__mini-map-wrap');
                    if (miniMapWrap && geo && !miniMapWrap.dataset.backToMapWired) {
                        miniMapWrap.dataset.backToMapWired = '1';
                        miniMapWrap.addEventListener(
                            'click',
                            function (ev) {
                                ev.preventDefault();
                                ev.stopPropagation();
                                closeMobileDetailModal();
                            },
                            true
                        );
                    }

                    function openCard() {
                        if (!card) return;
                        stopMapHeroGalleryAutoplay(mobileModal);
                        card.classList.remove('is-detail-modal-open');
                        document.body.classList.remove('map-detail-modal-open');
                        if (mobileModal) mobileModal.setAttribute('aria-hidden', 'true');
                        card.classList.add('is-open');
                        card.setAttribute('aria-hidden', 'false');
                        placeHeading();
                        syncTrailVisibility();
                        updateCardDockPosition();
                    }

                    function closeCard() {
                        if (!card) return;
                        stopMapHeroGalleryAutoplay(mobileModal);
                        card.classList.remove('is-detail-modal-open');
                        document.body.classList.remove('map-detail-modal-open');
                        if (mobileModal) mobileModal.setAttribute('aria-hidden', 'true');
                        card.classList.remove('is-open');
                        card.setAttribute('aria-hidden', 'true');
                        card.style.removeProperty('--map-card-dock-bottom');
                        placeHeading();
                        syncTrailVisibility();
                        invalidateMainMapSize();
                    }

                    document.querySelectorAll('.js-map-place-close').forEach(function (btn) {
                        btn.addEventListener('click', function (ev) {
                            ev.preventDefault();
                            ev.stopPropagation();
                            closeCard();
                        });
                    });

                    document.querySelectorAll('.js-map-place-modal-back, .js-map-place-modal-dismiss').forEach(function (btn) {
                        btn.addEventListener('click', function (ev) {
                            ev.preventDefault();
                            ev.stopPropagation();
                            closeMobileDetailModal();
                        });
                    });

                    var mobileStrip = card.querySelector('.map-place-card__mobile');
                    if (mobileStrip) {
                        mobileStrip.addEventListener('click', function (ev) {
                            /* Full detail view: tap-to-open only on small screens; strip stays a normal card on wider layouts. */
                            if (window.matchMedia && window.matchMedia('(min-width: 768px)').matches) return;
                            if (ev.target.closest('.js-map-place-close')) return;
                            if (ev.target.closest('.js-map-place-more-info')) return;
                            if (ev.target.closest('.js-map-directions')) return;
                            if (ev.target.closest('a[href]')) return;
                            openMobileDetailModal();
                        });
                    }

                    document.querySelectorAll('.js-map-place-more-info').forEach(function (btn) {
                        btn.addEventListener('click', function (ev) {
                            ev.preventDefault();
                            ev.stopPropagation();
                            openMobileDetailModal();
                        });
                    });

                    marker.on('click', function (ev) {
                        L.DomEvent.stopPropagation(ev);
                        openCard();
                    });

                    map.on('click', function () {
                        closeCard();
                    });

                    map.on('moveend', updateCardDockPosition);

                    map.on('zoomend', updateCardDockPosition);

                    function onMapShellResize() {
                        updateCardDockPosition();
                        updateStripDetailLine(trail, card);
                    }

                    window.addEventListener('resize', onMapShellResize);

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

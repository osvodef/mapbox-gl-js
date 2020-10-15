// @flow

import type SourceCache from './source_cache';
import type StyleLayer from '../style/style_layer';
import type CollisionIndex from '../symbol/collision_index';
import type Transform from '../geo/transform';
import type {RetainedQueryData} from '../symbol/placement';
import type {FilterSpecification} from '../style-spec/types';
import assert from 'assert';
import {mat4} from 'gl-matrix';

import {viewportPadding} from '../symbol/collision_index';
import Point from '@mapbox/point-geometry';

/*
 * Returns a matrix that can be used to convert from tile coordinates to viewport pixel coordinates.
 */
function getPixelPosMatrix(transform, tileID) {
    const t = mat4.identity([]);
    mat4.translate(t, t, [1, 1, 0]);
    mat4.scale(t, t, [transform.width * 0.5, transform.height * 0.5, 1]);
    return mat4.multiply(t, t, transform.calculatePosMatrix(tileID.toUnwrapped()));
}

function queryIncludes3DLayer(layers?: Array<string>, styleLayers: {[_: string]: StyleLayer}, sourceID: string) {
    if (layers) {
        for (const layerID of layers) {
            const layer = styleLayers[layerID];
            if (layer && layer.source === sourceID && layer.type === 'fill-extrusion') {
                return true;
            }
        }
    } else {
        for (const key in styleLayers) {
            const layer = styleLayers[key];
            if (layer.source === sourceID && layer.type === 'fill-extrusion') {
                return true;
            }
        }
    }
    return false;
}

export function queryRenderedFeatures(sourceCache: SourceCache,
                            styleLayers: {[_: string]: StyleLayer},
                            serializedLayers: {[_: string]: Object},
                            queryGeometry: Array<Point>,
                            params: { filter: FilterSpecification, layers: Array<string>, availableImages: Array<string> },
                            transform: Transform) {

    const has3DLayer = queryIncludes3DLayer(params && params.layers, styleLayers, sourceCache.id);
    const maxPitchScaleFactor = transform.maxPitchScaleFactor();
    const tilesIn = sourceCache.tilesIn(queryGeometry, maxPitchScaleFactor, has3DLayer);

    tilesIn.sort(sortTilesIn);
    const renderedFeatureLayers = [];
    for (const tileIn of tilesIn) {
        renderedFeatureLayers.push({
            wrappedTileID: tileIn.tileID.wrapped().key,
            queryResults: tileIn.tile.queryRenderedFeatures(
                styleLayers,
                serializedLayers,
                sourceCache._state,
                tileIn.queryGeometry,
                tileIn.cameraQueryGeometry,
                tileIn.scale,
                params,
                transform,
                maxPitchScaleFactor,
                getPixelPosMatrix(sourceCache.transform, tileIn.tileID))
        });
    }

    const result = mergeRenderedFeatureLayers(renderedFeatureLayers);

    // Merge state from SourceCache into the results
    for (const layerID in result) {
        result[layerID].forEach((featureWrapper) => {
            const feature = featureWrapper.feature;
            const state = sourceCache.getFeatureState(feature.layer['source-layer'], feature.id);
            feature.source = feature.layer.source;
            if (feature.layer['source-layer']) {
                feature.sourceLayer = feature.layer['source-layer'];
            }
            feature.state = state;
        });
    }
    return result;
}

export function queryRenderedSymbols(styleLayers: {[_: string]: StyleLayer},
                            serializedLayers: {[_: string]: StyleLayer},
                            sourceCaches: {[_: string]: SourceCache},
                            queryGeometry: Array<Point>,
                            params: { filter: FilterSpecification, layers: Array<string>, availableImages: Array<string> },
                            collisionIndex: CollisionIndex,
                            retainedQueryData: {[_: number]: RetainedQueryData}) {
    const result = {};
    const renderedSymbols = collisionIndex.queryRenderedSymbols(queryGeometry);
    const bucketQueryData = [];
    for (const bucketInstanceId of Object.keys(renderedSymbols).map(Number)) {
        bucketQueryData.push(retainedQueryData[bucketInstanceId]);
    }
    bucketQueryData.sort(sortTilesIn);

    for (const queryData of bucketQueryData) {
        const bucketSymbols = queryData.featureIndex.lookupSymbolFeatures(
                renderedSymbols[queryData.bucketInstanceId],
                serializedLayers,
                queryData.bucketIndex,
                queryData.sourceLayerIndex,
                params.filter,
                params.layers,
                params.availableImages,
                styleLayers);

        for (const layerID in bucketSymbols) {
            const resultFeatures = result[layerID] = result[layerID] || [];
            const layerSymbols = bucketSymbols[layerID];
            layerSymbols.sort((a, b) => {
                // Match topDownFeatureComparator from FeatureIndex, but using
                // most recent sorting of features from bucket.sortFeatures
                const featureSortOrder = queryData.featureSortOrder;
                if (featureSortOrder) {
                    // queryRenderedSymbols documentation says we'll return features in
                    // "top-to-bottom" rendering order (aka last-to-first).
                    // Actually there can be multiple symbol instances per feature, so
                    // we sort each feature based on the first matching symbol instance.
                    const sortedA = featureSortOrder.indexOf(a.featureIndex);
                    const sortedB = featureSortOrder.indexOf(b.featureIndex);
                    assert(sortedA >= 0);
                    assert(sortedB >= 0);
                    return sortedB - sortedA;
                } else {
                    // Bucket hasn't been re-sorted based on angle, so use the
                    // reverse of the order the features appeared in the data.
                    return b.featureIndex - a.featureIndex;
                }
            });
            for (const symbolFeature of layerSymbols) {
                appendAdditionalSymbolData(sourceCaches, styleLayers, queryData, layerID, symbolFeature);
                resultFeatures.push(symbolFeature);
            }
        }
    }

    // Merge state from SourceCache into the results
    for (const layerName in result) {
        result[layerName].forEach((featureWrapper) => {
            const feature = featureWrapper.feature;
            const layer = styleLayers[layerName];
            const sourceCache = sourceCaches[layer.source];
            const state = sourceCache.getFeatureState(feature.layer['source-layer'], feature.id);
            feature.source = feature.layer.source;
            if (feature.layer['source-layer']) {
                feature.sourceLayer = feature.layer['source-layer'];
            }
            feature.state = state;
        });
    }
    return result;
}

export function querySourceFeatures(sourceCache: SourceCache, params: any) {
    const tiles = sourceCache.getRenderableIds().map((id) => {
        return sourceCache.getTileByID(id);
    });

    const result = [];

    const dataTiles = {};
    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        const dataID = tile.tileID.canonical.key;
        if (!dataTiles[dataID]) {
            dataTiles[dataID] = true;
            tile.querySourceFeatures(result, params);
        }
    }

    return result;
}

function sortTilesIn(a, b) {
    const idA = a.tileID;
    const idB = b.tileID;
    return (idA.overscaledZ - idB.overscaledZ) || (idA.canonical.y - idB.canonical.y) || (idA.wrap - idB.wrap) || (idA.canonical.x - idB.canonical.x);
}

function mergeRenderedFeatureLayers(tiles) {
    // Merge results from all tiles, but if two tiles share the same
    // wrapped ID, don't duplicate features between the two tiles
    const result = {};
    const wrappedIDLayerMap = {};
    for (const tile of tiles) {
        const queryResults = tile.queryResults;
        const wrappedID = tile.wrappedTileID;
        const wrappedIDLayers = wrappedIDLayerMap[wrappedID] = wrappedIDLayerMap[wrappedID] || {};
        for (const layerID in queryResults) {
            const tileFeatures = queryResults[layerID];
            const wrappedIDFeatures = wrappedIDLayers[layerID] = wrappedIDLayers[layerID] || {};
            const resultFeatures = result[layerID] = result[layerID] || [];
            for (const tileFeature of tileFeatures) {
                if (!wrappedIDFeatures[tileFeature.featureIndex]) {
                    wrappedIDFeatures[tileFeature.featureIndex] = true;
                    resultFeatures.push(tileFeature);
                }
            }
        }
    }
    return result;
}

function appendAdditionalSymbolData(sourceCaches, styleLayers, queryData, layerID, symbolFeature) {
    const sourceCache = sourceCaches[styleLayers[layerID].source];
    const glyphCircles = sourceCache.style.placement.glyphCircles;
    const placedBoxes = sourceCache.style.placement.placedBoxes;
    const anchorAngles = sourceCache.style.placement.anchorAngles;
    const variableAnchors = sourceCache.style.placement.variableAnchors;
    const bucketID = queryData.bucketInstanceId;
    const featureID = symbolFeature.featureIndex;

    /* check if there is a placement path for this symbol. */
    if (bucketID in glyphCircles && featureID in glyphCircles[bucketID]) {
        const circles = glyphCircles[bucketID][featureID];
        const angles = anchorAngles[bucketID][featureID];
        let index = 0;
        symbolFeature.feature['paths'] = [];

        circles.forEach((path) => {
            let coords = [];

            /**
             * amount of unique coordinates.
             *
             * let k be (i * 4), then:
             * k is the x coordinate.
             * (k+1) is the y coordinate.
             * (k+2) is the radius.
             * (k+3) is the index.
             */
            const pathLen = path.length / 4;
            for (let i = 0; i < pathLen; i++) {
                /* coordinates have an extra padding. */
                coords.push(path[(i * 4)] - viewportPadding);
                coords.push(path[(i * 4) + 1] - viewportPadding);
            }

            /**
             * reverse the coordinate array if the x
             * of the first coordinate is higher than the
             * x of the last coordinate.
             */
            const len = coords.length / 2;
            if (coords[0] > coords[(coords.length - 2)]) {
                const reversed = [];
                for (let i = 1; i <= len; i++) {
                    reversed.push(coords[(len - i) * 2]);
                    reversed.push(coords[(len - i) * 2 + 1]);
                }

                coords = reversed;
            }

            const distance = 20;
            if (len === 1) {
                const angle = angles[index];
                const center = new Point(coords[0], coords[1]);
                let left = new Point(coords[0] - distance, coords[1]);
                let right = new Point(coords[0] + distance, coords[1]);
                /**
                 * x′ = ((x - cx) * cos(theta) + (y - cy) * sin(theta)) + cx
                 * y′ = (-(x - cx) * sin(theta) + (y - cy) * cos(theta)) + cy
                 * Where cx and cy are the center coordinates and theta
                 * is the angle in radians.
                 */
                left = left.rotateAround(angle, center);
                right = right.rotateAround(angle, center);
                symbolFeature.feature['paths'].push([left.x, left.y, right.x, right.y]);
            } else {
                // Extend the beginning of the path:
                const begin = extend(coords[2], coords[3], coords[0], coords[1], distance);
                if (begin !== undefined) {
                    coords[0] = begin.x;
                    coords[1] = begin.y;
                }

                // Extend the end of the path:
                const clen = coords.length;
                const end = extend(coords[clen - 4], coords[clen - 3], coords[clen - 2], coords[clen - 1], distance);
                if (end !== undefined) {
                    coords[clen - 2] = end.x;
                    coords[clen - 1] = end.y;
                }

                symbolFeature.feature['paths'].push(coords);
            }

            index++;
        });
    }

    /* check if there is a box to be placed for this symbol. */
    if (bucketID in placedBoxes && featureID in placedBoxes[bucketID]) {
        const boxes = placedBoxes[bucketID][featureID];
        symbolFeature.feature['boxes'] = [];

        boxes.forEach(box => {
            const coords = [];

            box.forEach(coord => {
                coords.push(coord - viewportPadding);
            });

            symbolFeature.feature['boxes'].push(coords);
        });
    }

    if (bucketID in anchorAngles && featureID in anchorAngles[bucketID]) {
        const angles = anchorAngles[bucketID][featureID];
        symbolFeature.feature['angles'] = [];

        angles.forEach(angle => {
            symbolFeature.feature['angles'].push(angle * 180 / Math.PI);
        });
    }

    if (bucketID in variableAnchors && featureID in variableAnchors[bucketID]) {
        symbolFeature.feature['placement-anchor'] = variableAnchors[bucketID][featureID];
    }
}

function extend(p1X, p1Y, p2X, p2Y, distance) {
    /* we cannot calculate the extension of a point. */
    if (p1X === p2X && p1Y === p2Y) {
        return;
    }

    const L = Math.sqrt(Math.pow((p1X - p2X), 2) + Math.pow(p1Y - p2Y, 2));
    const factor = (distance + L) / L;

    return {
        x: p1X + (p2X - p1X) * factor,
        y: p1Y + (p2Y - p1Y) * factor
    };
}

const accessToken = 'Fcl36Sb9lU5ynhsN8ofA47SqaVDPAlnG5b669b1f243a48e40fd719fef7b80ecbe75a54da';
const styleUrl = `https://vapi.bleeding.mapcreator.io/styles/Base%20Cartotest1.json?access_token=${accessToken}`;

run();

async function run() {
    const style = await fetch(styleUrl).then(response => response.json());

    const layers = style.layers.map(layer => layer.id);

    const stats = new window.Stats();
    const vtxPanel = stats.addPanel(new window.Stats.Panel('vtx', '#f8f', '#212'));
    const drawPanel = stats.addPanel(new window.Stats.Panel('dc', '#ff8', '#221'));

    stats.dom.style.bottom = '0';
    stats.dom.style.top = '';

    document.body.appendChild(stats.dom);

    window.stats = stats;
    window.vtxCounts = {};
    window.drawCount = 0;
    window.layers = layers;
    window.disabledLayers = new Set();
    window.style = style;

    const panel = document.querySelector('#panel');

    const map = new mapboxgl.Map({
        container: 'map',
        zoom: 4,
        center: [13.1, 48.23],
        style,
        hash: true,
        transformRequest: url => {
            return {
                url: `${url}?access_token=${accessToken}`,
            };
        },
    });

    map.on('render', e => {
        const { vtxCounts } = window;

        vtxPanel.update(getTotalVtxCount(vtxCounts), 10000000);
        drawPanel.update(window.drawCount, 1000);
    });

    map.on('idle', () => rerenderPanel());

    window.map = map;

    map.showTileBoundaries = true;
    map.showCollisionBoxes = false;
}

function rerenderPanel() {
    panel.innerHTML = renderLayerList(window.layers, window.vtxCounts, window.disabledLayers);

    document.querySelectorAll('.layer').forEach(element => {
        element.addEventListener('click', () => {
            const layerId = element.dataset.id;

            if (!disabledLayers.has(layerId)) {
                disabledLayers.add(layerId);
            } else {
                disabledLayers.delete(layerId);
            }

            rerenderPanel();
            updateLayers();
        });
    });
}

function renderLayerList(layerIds, vtxCounts, disabledLayers) {
    const layers = layerIds.map(layerId => {
        return {
            id: layerId,
            vtcs: vtxCounts[layerId] ?? 0,
        };
    });

    layers.sort((a, b) => b.vtcs - a.vtcs);

    const disabled = layers.filter(layer => disabledLayers.has(layer.id));
    const enabled = layers.filter(layer => !disabledLayers.has(layer.id));

    const maxVtxCount = layers[0].vtcs;

    let html = '';

    if (disabled.length > 0) {
        html += `<div class="layers-header">Disabled</div>`;
    }

    html += disabled.map(layer => renderLayer(layer, maxVtxCount)).join('');

    if (enabled.length > 0) {
        html += `<div class="layers-header">Enabled</div>`;
    }

    html += enabled.map(layer => renderLayer(layer, maxVtxCount)).join('');

    return html;
}

function renderLayer(layer, maxVtxCount) {
    const ratio = layer.vtcs / maxVtxCount;

    const opacity = disabledLayers.has(layer.id) ? 0.25 : 1;

    return `
        <div class="layer" data-id="${layer.id}" >
            <div class="layer-bar" style="width: ${ratio * 100}%; opacity: ${opacity}"></div>
            <div class="layer-text" style="opacity: ${opacity}">
                <div class="layer-id">${layer.id}</div>
                <div class="layer-vtcs">${formatNumber(layer.vtcs)}</div>
            </div>
        </div>
    `;
}

function updateLayers() {
    const style = { ...window.style };

    style.layers = style.layers.filter(layer => !disabledLayers.has(layer.id));

    map.setStyle(style);
}

function getTotalVtxCount(vtxCounts) {
    let total = 0;

    for (const key in vtxCounts) {
        total += vtxCounts[key];
    }

    return total;
}

function formatNumber(x) {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

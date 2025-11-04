/* ===============================
   IMD 2025 — Suffolk Choropleth
   Minimal, fast, no district filter
   =============================== */

/** 1) CONFIG — update the two URLs below to where you’ll host your files **/

// A. CSV path (your uploaded file). Host this alongside index.html/app.js.
const CSV_URL = "IMD2025_Suffolk.csv";

// B. GeoJSON path:
//    - Fastest: Suffolk-only LSOA 2021 polygons (recommended name below)
//    - Or: full England LSOA 2021, the code auto-filters to LSOAs present in the CSV
// IMPORTANT: Feature property for code should be LSOA21CD (preferred) or LSOA11CD or lsoa11cd.
const GEOJSON_URL = "suffolk_lsoa_2021.geojson"; // ← replace if you prefer a full-England URL

// Color-blind-safe sequential palette (10 classes, light→dark)
const SEQ_10 = [
  "#f3eef9", "#e0d4ef", "#cbb9e5", "#b49fdb", "#9a86cf",
  "#7d6cc1", "#5e55b0", "#3f3f9b", "#222c83", "#0d1b6e"
];

// Stroke + fill styles
const STYLE = {
  weight: 0.7,
  color: "#1a1f28",
  fillOpacity: 0.85
};

// Tooltip: short explanation line
const DECILE_NOTE = "Decile: 1 = most deprived … 10 = least deprived";

// Regex for the IMD domain decile columns we care about (top-level domains only)
const DOMAIN_DECILE_REGEX = new RegExp(
  "^(Index of Multiple Deprivation \\(IMD\\)|Income Deprivation Domain|Employment Deprivation Domain|Education, Skills and Training Domain|Health and Disability Domain|Crime Domain|Barriers to Housing and Services Domain|Living Environment Domain) Decile"
);

/** 2) STATE **/
let map, geojsonLayer, legendControl;
let lsoaDataByCode = new Map();     // LSOA code -> row object
let availableDomains = [];          // [{label, column}] derived from CSV
let currentDomainColumn = null;     // string column name
let lsoaCodeColumn = null;          // detected: "LSOA code (2021)" (from your CSV)
let lsoaNameColumn = null;          // detected: "LSOA name (2021)"

/** 3) INIT **/
init();

async function init() {
  showLoading(true);

  // 3.1 Load CSV
  const csv = await loadCSV(CSV_URL);
  detectKeyColumns(csv.meta.fields);
  indexCsvRows(csv.data);

  // 3.2 Build domain dropdown from CSV headers
  availableDomains = buildDomainList(csv.meta.fields);
  populateDomainDropdown(availableDomains);

  // 3.3 Load GeoJSON and render
  const gj = await fetch(GEOJSON_URL).then(r => r.json());
  setupMap();
  renderGeojson(gj);

  // 3.4 Initial domain selection
  if (availableDomains.length) {
    currentDomainColumn = availableDomains[0].column;
    document.getElementById("domain").value = currentDomainColumn;
    restyleChoropleth();
  }

  showLoading(false);
}

/** 4) LOADERS **/
function loadCSV(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true,
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: results => resolve(results),
      error: err => reject(err)
    });
  });
}

/** 5) CSV helpers **/
function detectKeyColumns(headers) {
  // Try to detect the LSOA code & name columns the CSV uses
  // Your file shows: "LSOA code (2021)" and "LSOA name (2021)"
  lsoaCodeColumn = headers.find(h => /^LSOA code/i.test(h)) || headers.find(h => /LSOA.*code/i.test(h));
  lsoaNameColumn = headers.find(h => /^LSOA name/i.test(h)) || headers.find(h => /LSOA.*name/i.test(h));

  if (!lsoaCodeColumn) throw new Error("Could not find the LSOA code column in CSV.");
  if (!lsoaNameColumn) console.warn("Could not find a clear LSOA name column; tooltips will omit name.");
}

function indexCsvRows(rows) {
  lsoaDataByCode.clear();
  for (const row of rows) {
    const code = String(row[lsoaCodeColumn]).trim();
    if (code) lsoaDataByCode.set(code, row);
  }
}

function buildDomainList(headers) {
  // Return only the 8 main IMD domains (incl. overall IMD)
  const list = [];
  for (const h of headers) {
    if (DOMAIN_DECILE_REGEX.test(h)) {
      // Make a short label
      const label = h.replace(" Decile (where 1 is most deprived 10% of LSOAs)", "")
                     .replace(" Decile (where 1 is most deprived)", "")
                     .replace("Index of Multiple Deprivation (IMD)", "IMD (Overall)");
      list.push({ label, column: h });
    }
  }
  // Stable order (optional)
  const desired = [
    "IMD (Overall)",
    "Income Deprivation Domain",
    "Employment Deprivation Domain",
    "Education, Skills and Training Domain",
    "Health and Disability Domain",
    "Crime Domain",
    "Barriers to Housing and Services Domain",
    "Living Environment Domain"
  ];
  list.sort((a,b) => desired.indexOf(a.label) - desired.indexOf(b.label));
  return list;
}

function populateDomainDropdown(list) {
  const sel = document.getElementById("domain");
  sel.innerHTML = "";
  for (const d of list) {
    const opt = document.createElement("option");
    opt.value = d.column;
    opt.textContent = d.label;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", e => {
    currentDomainColumn = e.target.value;
    restyleChoropleth();
  });
}

/** 6) MAP + GEOJSON **/
function setupMap() {
  map = L.map("map", {
    preferCanvas: true,
    minZoom: 7,
    maxZoom: 18
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  // Legend control
  legendControl = L.control({ position: "bottomright" });
  legendControl.onAdd = function() {
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML = `
      <div class="title">Decile (1–10)</div>
      ${renderLegendSwatches()}
      <div style="margin-top:.35rem;color:#9aa3af;">${DECILE_NOTE}</div>
    `;
    return div;
  };
  legendControl.addTo(map);
}

function renderGeojson(geojson) {
  // Figure out which property name carries the LSOA code in the GeoJSON
  const codeProp = detectGeojsonCodeProp(geojson);
  if (!codeProp) throw new Error("Could not detect an LSOA code property in GeoJSON (expected LSOA21CD/LSOA11CD/lsoa11cd).");

  // Filter the GeoJSON to polygons whose codes appear in our CSV
  const allowed = new Set(lsoaDataByCode.keys());
  const filtered = {
    type: "FeatureCollection",
    features: geojson.features.filter(f => {
      const code = String(f.properties?.[codeProp] ?? "").trim();
      return allowed.has(code);
    })
  };

  if (geojsonLayer) geojsonLayer.remove();

  geojsonLayer = L.geoJSON(filtered, {
    style: feature => styleForFeature(feature),
    onEachFeature: (feature, layer) => bindTooltip(feature, layer, codeProp)
  }).addTo(map);

  // Fit bounds to Suffolk
  try {
    map.fitBounds(geojsonLayer.getBounds(), { padding: [20, 20] });
  } catch (e) {
    map.setView([52.187, 1.0], 9); // fallback: Suffolk-ish
  }
}

function styleForFeature(feature) {
  const dec = getDecileForFeature(feature);
  const fillColor = getDecileColor(dec);
  return { ...STYLE, fillColor };
}

function bindTooltip(feature, layer, codeProp) {
  const code = String(feature.properties?.[codeProp] ?? "").trim();
  const row = lsoaDataByCode.get(code);
  if (!row) return;

  const name = lsoaNameColumn ? row[lsoaNameColumn] : "";
  const dec = getDecileFromRow(row, currentDomainColumn);
  const label = domainLabelFromColumn(currentDomainColumn);

  const html = `
    <div><strong>${name ? escapeHtml(name) + " · " : ""}${escapeHtml(code)}</strong></div>
    <div>${escapeHtml(label)} — <strong>${dec ?? "n/a"}</strong></div>
    <div style="color:#9aa3af">${DECILE_NOTE}</div>
  `;
  layer.bindTooltip(html, { sticky: true, direction: "auto" });
}

function getDecileForFeature(feature) {
  const codeProp = detectGeojsonCodePropFromFeature(feature);
  const code = String(feature.properties?.[codeProp] ?? "").trim();
  const row = lsoaDataByCode.get(code);
  if (!row || !currentDomainColumn) return null;
  return getDecileFromRow(row, currentDomainColumn);
}

function getDecileFromRow(row, column) {
  let v = row?.[column];
  if (v == null || v === "") return null;
  // Some CSVs might carry decimals; clamp to 1–10
  v = Math.round(Number(v));
  return (v >= 1 && v <= 10) ? v : null;
}

function getDecileColor(decile) {
  if (!decile) return "#c9d2df"; // fallback neutral
  // decile 1 (most deprived) -> darkest; reverse if you prefer
  return SEQ_10[decile - 1];
}

function restyleChoropleth() {
  if (!geojsonLayer) return;
  geojsonLayer.setStyle(styleForFeature);
  geojsonLayer.eachLayer(layer => {
    if (layer.setTooltipContent) {
      // Rebind tooltip to update domain label & decile
      const f = layer.feature;
      bindTooltip(f, layer, detectGeojsonCodePropFromFeature(f));
    }
  });
}

/** 7) UTIL **/
function detectGeojsonCodeProp(geojson) {
  const candidates = ["LSOA21CD", "LSOA11CD", "lsoa11cd", "lsoa21cd", "LSOA_CODE", "lsoa_code"];
  const sample = geojson.features?.[0]?.properties || {};
  for (const c of candidates) if (c in sample) return c;
  // Fallback: try to auto-detect something that looks like an LSOA code
  for (const k of Object.keys(sample)) {
    if (/^E01\d{7}$/i.test(String(sample[k]))) return k;
  }
  return null;
}
function detectGeojsonCodePropFromFeature(feature) {
  const props = feature.properties || {};
  const candidates = ["LSOA21CD", "LSOA11CD", "lsoa11cd", "lsoa21cd", "LSOA_CODE", "lsoa_code"];
  for (const c of candidates) if (c in props) return c;
  for (const k of Object.keys(props)) {
    if (/^E01\d{7}$/i.test(String(props[k]))) return k;
  }
  // Last resort
  return Object.keys(props)[0];
}

function domainLabelFromColumn(col) {
  const found = availableDomains.find(d => d.column === col);
  return found ? found.label : col;
}

function renderLegendSwatches() {
  // 10 rows: 1..10
  let html = "";
  for (let i = 1; i <= 10; i++) {
    html += `<div class="legend-row"><span class="swatch" style="background:${SEQ_10[i-1]}"></span><span>${i}</span></div>`;
  }
  return html;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showLoading(show) {
  const el = document.getElementById("loading");
  if (!el) return;
  el.style.display = show ? "grid" : "none";
}

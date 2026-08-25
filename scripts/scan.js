// ============================================================================
//  Albion Market Dashboard — script de scan
//  Lit scripts/items.json, interroge l'API AODP (prix + volumes),
//  calcule la rentabilité du flip .0 -> .1, filtre, et écrit docs/data.json.
//  Aucune dépendance externe : Node 18+ (fetch intégré).
// ============================================================================

const fs = require("fs");
const path = require("path");

// ----------------------------------------------------------------------------
//  CONFIGURATION  — tout ce que tu peux régler est ici.
// ----------------------------------------------------------------------------
const CONFIG = {
  // Serveur de TON compte de jeu. Change si tu joues sur Amériques ou Asie :
  //   Europe    : https://europe.albion-online-data.com
  //   Amériques : https://west.albion-online-data.com
  //   Asie      : https://east.albion-online-data.com
  SERVER: "https://europe.albion-online-data.com",

  // Villes analysées (le Black Market est volontairement exclu en v1).
  CITIES: [
    "Caerleon", "Bridgewatch", "Lymhurst",
    "Martlock", "Fort Sterling", "Thetford", "Brecilien",
  ],

  // --- Taxes et frais (en fractions : 0.04 = 4 %) ---
  SALES_TAX: 0.04,     // taxe de vente : 0.04 avec Premium, 0.08 sans
  SETUP_FEE: 0.025,    // frais de mise en vente (uniquement en modèle "listing")
  UNDERCUT: 0.02,      // on suppose qu'on sous-cote de 2 % pour vendre dans un délai raisonnable
  STATION_FEE_PCT: 0,  // approximation frais de station d'enchantement + nourriture,
                       // en % du coût total. Laisse 0 au début, ajuste après validation réelle.

  // --- Modèle de vente ---
  //  "listing" : on revend en plaçant un ordre de vente (plus de données, plus optimiste)
  //  "instant" : on revend instantanément dans un ordre d'achat (plus prudent, souvent moins de données)
  SALE_MODEL: "listing",

  // --- Filtres (le cœur de la qualité) ---
  FRESH_HOURS: 6,   // les 3 prix (base, enchanté, rune) doivent dater de moins de X heures
  MIN_VOLUME: 3,    // volume journalier minimum de l'objet enchanté pour être retenu
  MAX_ROI: 2.0,     // rejette les ROI > 200 % (quasi certainement une donnée aberrante)

  // --- Réalisme du profit/jour ---
  CAPACITY_CAP: 50, // nb max d'unités/jour que tu peux réalistement écouler par objet

  // --- Sortie ---
  TOP_PER_CITY: 25, // on garde les 25 meilleurs par ville (le dashboard affichera le top 10)

  // --- Technique ---
  BATCH_SIZE: 50,   // nb d'objets par requête (reste sous la limite d'URL de 4096 caractères)
  DELAY_MS: 400,    // pause entre requêtes (respect des limites 180/min, 300/5min)
  USER_AGENT: "albion-market-dashboard/1.0 (projet personnel)",
};

// ----------------------------------------------------------------------------
//  OUTILS
// ----------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function ageHours(dateStr) {
  if (!dateStr) return Infinity;
  // les dates AODP sont en UTC ; on force le "Z" si absent
  const iso = dateStr.endsWith("Z") ? dateStr : dateStr + "Z";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / 3.6e6;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "User-Agent": CONFIG.USER_AGENT,
    },
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " sur " + url);
  return res.json();
}

const locParam = () => CONFIG.CITIES.map(encodeURIComponent).join(",");

// ----------------------------------------------------------------------------
//  RÉCUPÉRATION DES PRIX
//  Construit priceMap[itemId][city] = { sell_min, sell_date, buy_max, buy_date }
// ----------------------------------------------------------------------------
async function fetchPrices(itemIds) {
  const priceMap = {};
  const batches = chunk([...new Set(itemIds)], CONFIG.BATCH_SIZE);
  let done = 0;
  for (const batch of batches) {
    const ids = batch.join(",");
    const url = `${CONFIG.SERVER}/api/v2/stats/prices/${ids}.json?locations=${locParam()}&qualities=1`;
    const rows = await fetchJson(url);
    for (const r of rows) {
      const id = r.item_id;
      const city = r.city || r.location;
      if (!priceMap[id]) priceMap[id] = {};
      priceMap[id][city] = {
        sell_min: r.sell_price_min || 0,
        sell_date: r.sell_price_min_date,
        buy_max: r.buy_price_max || 0,
        buy_date: r.buy_price_max_date,
      };
    }
    done++;
    console.log(`  prix : lot ${done}/${batches.length} (${batch.length} objets)`);
    await sleep(CONFIG.DELAY_MS);
  }
  return priceMap;
}

// ----------------------------------------------------------------------------
//  RÉCUPÉRATION DES VOLUMES (historique)
//  Construit volMap[itemId][city] = volume journalier moyen
// ----------------------------------------------------------------------------
async function fetchVolumes(itemIds) {
  const volMap = {};
  const batches = chunk([...new Set(itemIds)], CONFIG.BATCH_SIZE);
  let done = 0;
  for (const batch of batches) {
    const ids = batch.join(",");
    const url = `${CONFIG.SERVER}/api/v2/stats/history/${ids}.json?locations=${locParam()}&qualities=1&time-scale=24`;
    let rows;
    try {
      rows = await fetchJson(url);
    } catch (e) {
      console.log("  (volume) lot ignoré :", e.message);
      done++; await sleep(CONFIG.DELAY_MS); continue;
    }
    for (const r of rows) {
      const id = r.item_id;
      const city = r.city || r.location;
      const data = r.data || [];
      if (!data.length) continue;
      const avg = data.reduce((s, d) => s + (d.item_count || 0), 0) / data.length;
      if (!volMap[id]) volMap[id] = {};
      volMap[id][city] = avg;
    }
    done++;
    console.log(`  volume : lot ${done}/${batches.length}`);
    await sleep(CONFIG.DELAY_MS);
  }
  return volMap;
}

// ----------------------------------------------------------------------------
//  CALCUL DE RENTABILITÉ pour un objet dans une ville
// ----------------------------------------------------------------------------
function computeOpportunity(item, city, priceMap, volMap) {
  const base = priceMap[item.base_id]?.[city];
  const ench = priceMap[item.enchanted_id]?.[city];
  const rune = priceMap[item.rune_id]?.[city];
  if (!base || !ench || !rune) return null;

  const basePrice = base.sell_min;                 // ce que je paie pour l'objet .0
  const runePrice = rune.sell_min;                 // prix unitaire de la rune
  if (basePrice <= 0 || runePrice <= 0) return null;

  const matCost = item.rune_count * runePrice;
  const totalCost = (basePrice + matCost) * (1 + CONFIG.STATION_FEE_PCT);

  // --- côté vente ---
  let grossSale, saleDate;
  if (CONFIG.SALE_MODEL === "instant") {
    grossSale = ench.buy_max * (1 - CONFIG.SALES_TAX);
    saleDate = ench.buy_date;
  } else {
    grossSale = ench.sell_min * (1 - CONFIG.UNDERCUT) * (1 - CONFIG.SALES_TAX - CONFIG.SETUP_FEE);
    saleDate = ench.sell_date;
  }
  if (grossSale <= 0) return null;

  const profit = grossSale - totalCost;
  const roi = profit / totalCost;

  // --- fraîcheur : le pire des trois âges ---
  const age = Math.max(ageHours(base.sell_date), ageHours(saleDate), ageHours(rune.sell_date));

  // --- volume ---
  const volume = volMap[item.enchanted_id]?.[city] || 0;

  const profitPerDay = profit * Math.min(volume, CONFIG.CAPACITY_CAP);

  return {
    base_id: item.base_id,
    enchanted_id: item.enchanted_id,
    name_fr: item.name_fr,
    category: item.category,
    tier: item.tier,
    buy_cost: Math.round(basePrice),
    mat_cost: Math.round(matCost),
    rune_count: item.rune_count,
    sale: Math.round(grossSale),
    profit: Math.round(profit),
    roi: +(roi * 100).toFixed(1),
    volume: +volume.toFixed(1),
    profit_per_day: Math.round(profitPerDay),
    age_hours: +age.toFixed(1),
  };
}

// ----------------------------------------------------------------------------
//  PROGRAMME PRINCIPAL
// ----------------------------------------------------------------------------
async function main() {
  const itemsPath = path.join(__dirname, "items.json");
  const { items } = JSON.parse(fs.readFileSync(itemsPath, "utf-8"));
  console.log(`Table chargée : ${items.length} objets.`);

  // Liste des IDs de prix nécessaires : base + enchanté + runes (T4_RUNE, T5_RUNE...)
  const priceIds = new Set();
  const runeIds = new Set();
  for (const it of items) {
    priceIds.add(it.base_id);
    priceIds.add(it.enchanted_id);
    priceIds.add(it.rune_id);
    runeIds.add(it.rune_id);
  }

  console.log("Récupération des prix…");
  const priceMap = await fetchPrices([...priceIds]);

  console.log("Récupération des volumes…");
  const volMap = await fetchVolumes(items.map((i) => i.enchanted_id));

  // --- calcul + filtres, par ville ---
  const results = {};
  let kept = 0, total = 0;
  for (const city of CONFIG.CITIES) results[city] = [];

  for (const it of items) {
    for (const city of CONFIG.CITIES) {
      total++;
      const opp = computeOpportunity(it, city, priceMap, volMap);
      if (!opp) continue;
      // TRIPLE FILTRE : fraîcheur + volume + bornes de marge
      if (opp.age_hours > CONFIG.FRESH_HOURS) continue;
      if (opp.volume < CONFIG.MIN_VOLUME) continue;
      if (opp.roi <= 0 || opp.roi > CONFIG.MAX_ROI * 100) continue;
      results[city].push(opp);
      kept++;
    }
  }

  // tri par ROI décroissant + on garde le top N par ville
  for (const city of CONFIG.CITIES) {
    results[city].sort((a, b) => b.roi - a.roi);
    results[city] = results[city].slice(0, CONFIG.TOP_PER_CITY);
  }

  console.log(`Opportunités retenues : ${kept} (sur ${total} combinaisons objet×ville).`);

  // --- sécurité : si tout est vide (souvent = API en panne), on n'écrase pas l'ancien fichier ---
  if (kept === 0) {
    console.error("Aucune opportunité retenue — fichier data.json NON réécrit (données douteuses).");
    process.exit(1);
  }

  const out = {
    generated_utc: new Date().toISOString(),
    server: CONFIG.SERVER,
    cities: CONFIG.CITIES,
    config: {
      sale_model: CONFIG.SALE_MODEL,
      sales_tax: CONFIG.SALES_TAX,
      fresh_hours: CONFIG.FRESH_HOURS,
      min_volume: CONFIG.MIN_VOLUME,
    },
    results,
  };

  const outPath = path.join(__dirname, "..", "docs", "data.json");
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log("Écrit :", outPath);
}

main().catch((e) => {
  console.error("ERREUR :", e.message);
  process.exit(1);
});

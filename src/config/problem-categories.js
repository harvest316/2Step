/**
 * PROBLEM_CATEGORIES — maps niches to service categories, each with synonym lists.
 *
 * Used by the reviews stage to:
 *  1. Find reviews that mention a specific service type.
 *  2. Tag the site with a `problem_category` so the video render pulls the
 *     correct clip pool (e.g. "termite treatment" uses termite B-roll).
 *
 * Structure:
 *   PROBLEM_CATEGORIES[niche][category] = [keyword, keyword, ...]
 *
 * A review "matches" a category when it contains at least one of the category's
 * keywords (case-insensitive, substring match).
 *
 * When multiple categories match, the one with the most keyword hits wins.
 * If no category matches, the business is skipped (no relevant review found).
 */

export const PROBLEM_CATEGORIES = {

  // ─── Pest Control ────────────────────────────────────────────────────────────
  'pest control': {
    'termite treatment': [
      'termite', 'termites', 'white ant', 'white ants', 'subterranean',
      'termite inspection', 'termite barrier', 'termite bait', 'termite damage',
      'termite nest', 'termite colony', 'drywood termite',
    ],
    'general pest spray': [
      'general pest', 'pest spray', 'pest treatment', 'pest inspection',
      'general treatment', 'interior spray', 'exterior spray', 'perimeter spray',
      'pest control service', 'pest management', 'fumigation',
    ],
    'rodent control': [
      'rat', 'rats', 'mouse', 'mice', 'rodent', 'rodents',
      'rat bait', 'rat trap', 'mouse trap', 'rat infestation',
      'mice infestation', 'rodent infestation', 'rat problem',
    ],
    'cockroach': [
      'cockroach', 'cockroaches', 'roach', 'roaches',
      'german cockroach', 'american cockroach', 'cockroach infestation',
      'cockroach treatment', 'cockroach gel',
    ],
    'ant treatment': [
      'ant', 'ants', 'ant nest', 'ant infestation', 'ant colony',
      'ant trail', 'ant treatment', 'fire ant', 'bull ant',
      'carpenter ant', 'argentine ant', 'ant baiting',
    ],
    'spider': [
      'spider', 'spiders', 'redback', 'redback spider', 'funnel web',
      'huntsman', 'white tail', 'whitetail', 'black house spider',
      'spider web', 'spider treatment', 'spider infestation',
    ],
    'bee/wasp removal': [
      'bee', 'bees', 'wasp', 'wasps', 'hornet', 'hornets',
      'bee hive', 'beehive', 'bee nest', 'wasp nest', 'bee swarm',
      'bee removal', 'wasp removal', 'bee colony', 'yellow jacket',
    ],
    'possum': [
      'possum', 'possums', 'possum removal', 'possum trap',
      'possum in roof', 'possum in ceiling', 'possum in attic',
      'possum scratching', 'possum noise',
    ],
    'bed bugs': [
      'bed bug', 'bed bugs', 'bedbug', 'bedbugs',
      'bed bug treatment', 'bed bug infestation', 'bed bug inspection',
      'bed bug bite', 'bed bug bites',
    ],
    'flea treatment': [
      'flea', 'fleas', 'flea treatment', 'flea infestation',
      'flea spray', 'flea bomb', 'cat flea', 'dog flea',
    ],
    'silverfish': [
      'silverfish', 'silverfish treatment', 'silverfish infestation',
      'silverfish damage', 'book lice',
    ],
    'mosquito control': [
      'mosquito', 'mosquitoes', 'mozzie', 'mozzies',
      'mosquito treatment', 'mosquito control', 'mosquito spray',
      'mosquito barrier',
    ],
  },

  // ─── Plumber ─────────────────────────────────────────────────────────────────
  'plumber': {
    'blocked drain': [
      'blocked drain', 'blocked drains', 'clogged drain', 'clogged drains',
      'drain blocked', 'drain clogged', 'blocked pipe', 'blocked sewer',
      'drain clearing', 'drain unblocking', 'slow drain', 'overflowing drain',
      'sewer blockage', 'drain camera',
    ],
    'hot water': [
      'hot water', 'hot water system', 'hot water heater', 'water heater',
      'no hot water', 'hot water repair', 'hot water installation',
      'storage hot water', 'continuous hot water', 'solar hot water',
      'heat pump', 'rheem', 'rinnai', 'dux', 'aquamax', 'bosch',
    ],
    'leak repair': [
      'leak', 'leaking', 'leaky', 'dripping', 'dripping tap',
      'water leak', 'pipe leak', 'tap leak', 'burst pipe', 'broken pipe',
      'leaking pipe', 'leaking tap', 'leaking toilet', 'water damage',
      'water pressure', 'hidden leak',
    ],
    'bathroom renovation': [
      'bathroom reno', 'bathroom renovation', 'bathroom remodel',
      'new bathroom', 'bathroom fit out', 'bathroom fitting',
      'bathroom install', 'shower installation', 'bath installation',
      'vanity installation', 'bathroom plumbing',
    ],
    'toilet repair': [
      'toilet', 'cistern', 'toilet blocked', 'blocked toilet',
      'overflowing toilet', 'running toilet', 'toilet repair',
      'toilet installation', 'toilet replacement', 'toilet flush',
      'toilet seat',
    ],
    'gas fitting': [
      'gas', 'gas fitting', 'gas fitter', 'gas leak', 'gas appliance',
      'gas hot water', 'gas connection', 'gas installation', 'gas certificate',
      'gas cooktop', 'gas heater', 'natural gas', 'lpg',
    ],
    'kitchen plumbing': [
      'kitchen sink', 'kitchen tap', 'dishwasher connection',
      'sink blocked', 'kitchen plumbing', 'kitchen renovation',
      'garbage disposal',
    ],
    'pipe relining': [
      'pipe relining', 'pipe reline', 'pipe lining',
      'no dig', 'trenchless', 'cured in place', 'old pipes',
    ],
  },

  // ─── Dentist ─────────────────────────────────────────────────────────────────
  'dentist': {
    'teeth cleaning': [
      'clean', 'cleaning', 'hygiene', 'scale and clean', 'scale & clean',
      'teeth clean', 'teeth cleaning', 'dental clean', 'dental hygiene',
      'plaque', 'tartar', 'polish', 'preventive',
    ],
    'whitening': [
      'whitening', 'whiten', 'white teeth', 'teeth whitening',
      'tooth whitening', 'zoom whitening', 'bleaching', 'bright smile',
    ],
    'emergency': [
      'emergency', 'toothache', 'tooth ache', 'tooth pain', 'dental pain',
      'broken tooth', 'cracked tooth', 'chipped tooth', 'urgent',
      'same day', 'weekend dentist', 'after hours',
    ],
    'implants': [
      'implant', 'implants', 'dental implant', 'dental implants',
      'tooth implant', 'implant crown', 'all on 4', 'full mouth restoration',
      'bone graft', 'implant supported',
    ],
    'orthodontics': [
      'braces', 'invisalign', 'clear aligner', 'clear aligners',
      'orthodontic', 'orthodontics', 'teeth straightening', 'straight teeth',
      'retainer', 'wire braces', 'ceramic braces', 'lingual braces',
    ],
    'veneers': [
      'veneer', 'veneers', 'porcelain veneer', 'porcelain veneers',
      'composite veneer', 'smile makeover', 'cosmetic dentist',
      'cosmetic dentistry', 'smile design',
    ],
    'root canal': [
      'root canal', 'root treatment', 'endodontic', 'endodontics',
      'infected tooth', 'nerve', 'pulp',
    ],
    'extraction': [
      'extraction', 'tooth extraction', 'pulled tooth', 'remove tooth',
      'wisdom tooth', 'wisdom teeth', 'impacted',
    ],
    'crown and bridge': [
      'crown', 'crowns', 'dental crown', 'bridge', 'dental bridge',
      'cap', 'caps', 'missing tooth', 'missing teeth', 'replace tooth',
    ],
    'children dental': [
      'children', 'child', 'kids', 'kid', 'family dentist',
      'paediatric', 'pediatric', 'school dental', 'child dentist',
      'kids dentist',
    ],
  },

  // ─── Electrician ─────────────────────────────────────────────────────────────
  'electrician': {
    'switchboard upgrade': [
      'switchboard', 'meter board', 'fuse box', 'circuit breaker',
      'switchboard upgrade', 'switchboard replacement', 'tripping',
      'power tripping', 'main switch',
    ],
    'power point installation': [
      'power point', 'power points', 'powerpoint', 'gpo',
      'extra power point', 'new power point', 'power outlet', 'usb power point',
    ],
    'lighting installation': [
      'light', 'lights', 'lighting', 'downlight', 'downlights',
      'led lighting', 'light installation', 'light fitting', 'chandelier',
      'outdoor lighting', 'sensor light', 'dimmer',
    ],
    'ev charger': [
      'ev charger', 'electric car charger', 'ev charging', 'tesla charger',
      'home charger', 'electric vehicle', 'car charger installation',
    ],
    'solar installation': [
      'solar', 'solar panels', 'solar system', 'solar installation',
      'solar power', 'photovoltaic', 'pv system', 'battery storage',
      'solar battery', 'enphase', 'fronius', 'sungrow',
    ],
    'ceiling fan': [
      'ceiling fan', 'fan installation', 'fan fitting', 'ceiling fan install',
      'air circulation', 'exhaust fan',
    ],
    'fault finding': [
      'fault', 'no power', 'power outage', 'electrical fault',
      'electrical problem', 'tripping', 'burning smell', 'electrical smell',
      'sparking', 'short circuit',
    ],
    'air conditioning': [
      'air conditioning', 'air con', 'aircon', 'ac unit', 'split system',
      'ducted air', 'hvac', 'cooling', 'heating and cooling',
      'mitsubishi', 'daikin', 'fujitsu', 'panasonic', 'carrier',
    ],
  },

  // ─── Roofer ──────────────────────────────────────────────────────────────────
  'roofing': {
    'roof repair': [
      'roof repair', 'roof leak', 'leaking roof', 'roof damage',
      'broken tile', 'cracked tile', 'missing tile', 'roof tile',
      'roof patch', 'emergency roof',
    ],
    'full roof replacement': [
      'roof replacement', 'new roof', 're-roof', 'reroof',
      'full roof', 'complete roof', 'colorbond roof', 'metal roof',
    ],
    'roof restoration': [
      'roof restoration', 'roof recoat', 'roof paint', 'roof repaint',
      'roof cleaning', 'roof rejuvenation', 'moss removal', 'lichen removal',
    ],
    'gutters': [
      'gutter', 'gutters', 'downpipe', 'downpipes', 'gutter guard',
      'gutter cleaning', 'gutter replacement', 'fascia', 'eaves',
      'overflowing gutter',
    ],
    'skylights': [
      'skylight', 'skylights', 'roof window', 'velux', 'solatube',
      'natural light', 'roof light',
    ],
    'roof inspection': [
      'roof inspection', 'roof report', 'pre-purchase', 'pre purchase',
      'roof assessment', 'thermal imaging',
    ],
  },

  // ─── HVAC ─────────────────────────────────────────────────────────────────────
  'hvac': {
    'ducted installation': [
      'ducted', 'ducted system', 'ducted air', 'ducted heating',
      'ducted cooling', 'duct installation', 'zoning',
    ],
    'split system installation': [
      'split system', 'wall unit', 'mini split', 'split air con',
      'split system install', 'split system replacement',
    ],
    'service and maintenance': [
      'service', 'maintenance', 'annual service', 'ac service',
      'filter clean', 'coil clean', 'hvac service', 'tuneup', 'tune up',
    ],
    'repair': [
      'repair', 'not cooling', 'not heating', 'ac repair', 'ac problem',
      'breakdown', 'faulty', 'stopped working', 'hvac repair',
    ],
    'evaporative cooling': [
      'evaporative', 'evaporative cooling', 'swamp cooler',
      'evaporative system', 'evap cooling',
    ],
    'commercial hvac': [
      'commercial', 'office', 'retail', 'warehouse', 'industrial',
      'commercial hvac', 'commercial air conditioning',
    ],
  },

  // ─── Real Estate ─────────────────────────────────────────────────────────────
  'real estate': {
    'property management': [
      'property management', 'rental management', 'property manager',
      'rental property', 'investment property', 'landlord', 'tenant',
      'managing agent',
    ],
    'home sales': [
      'sold', 'sale', 'selling', 'listed', 'listing', 'auction',
      'private sale', 'house sold', 'sold my home', 'sold our home',
      'asking price', 'above reserve',
    ],
    'home purchase': [
      'bought', 'purchase', 'buying', 'first home', 'first home buyer',
      'dream home', 'found us', 'helped us buy',
    ],
    'appraisal': [
      'appraisal', 'market appraisal', 'free appraisal', 'property value',
      'valuation', 'price guide',
    ],
    'investment': [
      'investment', 'invest', 'portfolio', 'yield', 'capital growth',
      'rental yield', 'cash flow',
    ],
  },

  // ─── Chiropractor ────────────────────────────────────────────────────────────
  'chiropractor': {
    'back pain': [
      'back pain', 'lower back', 'back ache', 'backache', 'lumbar',
      'disc', 'slipped disc', 'herniated disc', 'sciatica',
    ],
    'neck pain': [
      'neck pain', 'neck ache', 'neck stiffness', 'stiff neck',
      'cervical', 'whiplash',
    ],
    'headache/migraine': [
      'headache', 'headaches', 'migraine', 'migraines', 'tension headache',
      'cluster headache',
    ],
    'posture': [
      'posture', 'posture correction', 'hunched', 'slouch',
      'rounded shoulders', 'desk posture',
    ],
    'sports injury': [
      'sport', 'sports', 'sports injury', 'running', 'gym', 'athlete',
      'shoulder pain', 'knee pain', 'ankle', 'hip pain', 'muscle pain',
    ],
    'pregnancy': [
      'pregnancy', 'pregnant', 'prenatal', 'postnatal', 'post natal',
      'baby', 'maternity',
    ],
    'general adjustment': [
      'adjustment', 'cracking', 'spinal', 'spine', 'alignment',
      'manipulation', 'chiropractic adjustment', 'general wellness',
    ],
  },

  // ─── Personal Injury Lawyer ───────────────────────────────────────────────────
  'personal injury lawyer': {
    'car accident': [
      'car accident', 'motor vehicle accident', 'mva', 'car crash',
      'road accident', 'collision', 'rear end', 'whiplash',
      'third party', 'insurance claim',
    ],
    "workers' compensation": [
      'workers compensation', "workers' compensation", 'work injury',
      'workplace injury', 'workcover', 'work accident',
      'injured at work', 'compensation claim',
    ],
    'slip and fall': [
      'slip', 'fall', 'slip and fall', 'trip and fall', 'public liability',
      'supermarket', 'shopping centre', 'footpath', 'premises liability',
    ],
    'medical negligence': [
      'medical negligence', 'medical malpractice', 'hospital',
      'doctor error', 'surgical error', 'misdiagnosis',
    ],
    'tpd/disability': [
      'tpd', 'total and permanent disability', 'disability',
      'income protection', 'superannuation claim', 'super claim',
      'life insurance claim',
    ],
  },

  // ─── Pool Installer ───────────────────────────────────────────────────────────
  'pool installer': {
    'inground pool': [
      'inground pool', 'in-ground pool', 'concrete pool', 'fibreglass pool',
      'fiberglass pool', 'pool installation', 'new pool', 'pool build',
      'pool construction',
    ],
    'pool renovation': [
      'pool renovation', 'pool resurfacing', 'pool reno', 'pool makeover',
      'pool update', 'pool refurbish', 'pool remodel',
    ],
    'pool equipment': [
      'pool pump', 'pool filter', 'pool heater', 'heat pump',
      'salt water', 'chlorinator', 'pool cleaner', 'robotic cleaner',
      'pool lighting', 'variable speed',
    ],
    'pool fencing': [
      'pool fence', 'pool fencing', 'glass fence', 'frameless fence',
      'safety fence', 'pool barrier', 'fence installation',
    ],
    'spa/plunge pool': [
      'spa', 'hot tub', 'plunge pool', 'swim spa', 'above ground',
      'above-ground pool', 'lap pool',
    ],
  },

  // ─── Dog Trainer ─────────────────────────────────────────────────────────────
  'dog trainer': {
    'puppy training': [
      'puppy', 'puppies', 'puppy training', 'puppy class', 'puppy school',
      'puppy socialisation', 'new puppy', 'young dog',
    ],
    'obedience training': [
      'obedience', 'basic training', 'sit', 'stay', 'recall',
      'commands', 'heel', 'lead training', 'leash training',
    ],
    'aggression': [
      'aggression', 'aggressive', 'biting', 'bite', 'lunging',
      'reactive', 'reactivity', 'growling', 'fearful',
    ],
    'anxiety/separation': [
      'anxiety', 'separation anxiety', 'fear', 'scared', 'nervous',
      'barking', 'destructive', 'alone', 'velcro dog',
    ],
    'off-leash': [
      'off leash', 'off-leash', 'recall', 'come when called',
      'freedom', 'running off', 'unleashed',
    ],
    'boarding/daycare': [
      'boarding', 'daycare', 'day care', 'dog boarding',
      'home boarding', 'dog hotel', 'doggy daycare',
    ],
  },

  // ─── Med Spa ──────────────────────────────────────────────────────────────────
  'med spa': {
    'botox/anti-wrinkle': [
      'botox', 'anti-wrinkle', 'anti wrinkle', 'wrinkle injection',
      'muscle relaxant', 'frown lines', 'forehead lines', 'crows feet',
      'brow lift',
    ],
    'filler': [
      'filler', 'fillers', 'lip filler', 'cheek filler', 'dermal filler',
      'nose filler', 'tear trough', 'jawline filler', 'volume',
    ],
    'skin rejuvenation': [
      'skin rejuvenation', 'laser', 'ipl', 'photofacial', 'skin refresh',
      'skin resurfacing', 'fraxel', 'clear + brilliant',
    ],
    'body contouring': [
      'body contouring', 'fat reduction', 'coolsculpting', 'sculpt',
      'inch loss', 'body shaping', 'liposuction',
    ],
    'skin tightening': [
      'skin tightening', 'hifu', 'ultherapy', 'ulthera', 'radiofrequency',
      'rf', 'thermage', 'laxity', 'sagging',
    ],
    'hydrafacial/peels': [
      'hydrafacial', 'hydra facial', 'chemical peel', 'facial treatment',
      'facials', 'led facial', 'deep cleanse', 'microdermabrasion',
      'microneedling',
    ],
    'pgr/hair loss': [
      'prp', 'hair loss', 'hair thinning', 'scalp', 'hair regrowth',
      'alopecia', 'hair restoration',
    ],
  },

};

/**
 * Find the best matching category for a review text within a niche.
 *
 * Returns `{ category, hits }` where `hits` is the count of matching keywords,
 * or `null` if no category matched.
 *
 * @param {string} niche - e.g. "pest control"
 * @param {string} reviewText
 * @returns {{ category: string, hits: number } | null}
 */
export function matchCategory(niche, reviewText) {
  const categories = PROBLEM_CATEGORIES[niche.toLowerCase()];
  if (!categories) return null;

  const lower = reviewText.toLowerCase();
  let best = null;

  for (const [category, keywords] of Object.entries(categories)) {
    const hits = keywords.filter(kw => lower.includes(kw)).length;
    if (hits > 0 && (!best || hits > best.hits)) {
      best = { category, hits };
    }
  }

  return best;
}

/**
 * Build a flat keyword list for all categories in a niche, suitable for the
 * Outscraper Reviews API `query` filter parameter.
 *
 * Outscraper supports OR-matching when multiple query terms are provided, but
 * the API takes a single query string — we join with spaces (implicit OR).
 * We cap the list to avoid oversized query strings.
 *
 * @param {string} niche - e.g. "pest control"
 * @param {string|null} category - if set, only keywords for that category
 * @param {number} maxTerms - cap on number of terms (default 30)
 * @returns {string} space-joined keyword string
 */
export function buildReviewQueryString(niche, category = null, maxTerms = 30) {
  const categories = PROBLEM_CATEGORIES[niche.toLowerCase()];
  if (!categories) return niche;

  const terms = new Set();

  if (category && categories[category]) {
    for (const kw of categories[category]) terms.add(kw);
  } else {
    for (const keywords of Object.values(categories)) {
      for (const kw of keywords) terms.add(kw);
    }
  }

  return [...terms].slice(0, maxTerms).join(' ');
}

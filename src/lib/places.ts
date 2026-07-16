import { config } from '../config.js';

/**
 * Google Places lookup (new Places API v1) for the GBP optimization step.
 * Returns the best matching place or null. Field mask keeps the response small.
 *
 * TODO VERIFY: confirm the Places API (New) is enabled on the GOOGLE_PLACES_API_KEY
 * project. If the key is restricted to the legacy API, swap to the
 * maps.googleapis.com/maps/api/place/textsearch/json endpoint.
 */
export interface PlaceRecord {
  id: string;
  name: string;
  formattedAddress?: string;
  phone?: string;
  website?: string;
  rating?: number;
  types?: string[];
  hours?: string[];
  raw: unknown;
}

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.types',
  'places.regularOpeningHours.weekdayDescriptions',
].join(',');

export async function searchPlace(textQuery: string): Promise<PlaceRecord | null> {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': config.googlePlaces.apiKey(),
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({ textQuery, maxResultCount: 1 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`places.searchText: ${res.status} ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as { places?: any[] };
  const p = data.places?.[0];
  if (!p) return null;
  return {
    id: p.id,
    name: p.displayName?.text ?? '',
    formattedAddress: p.formattedAddress,
    phone: p.nationalPhoneNumber,
    website: p.websiteUri,
    rating: p.rating,
    types: p.types,
    hours: p.regularOpeningHours?.weekdayDescriptions,
    raw: p,
  };
}

/**
 * Structured, Places-validated NAP address (spec: validate the client-typed
 * office address, since clients make typos - e.g. a mistyped ZIP). Only
 * `street`/`city`/`state`/`zip` are used to populate the profile; `nap_address`
 * (the single-line form built from them) stays internally consistent rather
 * than mixing a corrected zip with an uncorrected raw address string.
 */
export interface ValidatedAddress {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  placeId: string;
  /** True only when street+city+state+zip all resolved - a partial Places
   *  match (e.g. city found but no zip) is treated as unmatched so a bad
   *  partial correction never overwrites good client-entered data. */
  complete: boolean;
}

const ADDRESS_FIELD_MASK = ['places.id', 'places.formattedAddress', 'places.addressComponents'].join(',');

interface AddressComponent { longText?: string; shortText?: string; types?: string[] }

function pickComponent(components: AddressComponent[], type: string, useShort = false): string | undefined {
  const c = components.find((x) => x.types?.includes(type));
  if (!c) return undefined;
  return (useShort ? c.shortText : c.longText) || undefined;
}

/**
 * Look up a raw client-typed office address via Places Text Search and parse
 * it into street/city/state/zip. Returns null if Places has no match at all;
 * returns `complete: false` if Places matched something but couldn't resolve
 * every component (caller should not apply a partial correction).
 */
export async function validateAddress(rawAddress: string, bizName?: string): Promise<ValidatedAddress | null> {
  const textQuery = [bizName, rawAddress].filter(Boolean).join(', ');
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': config.googlePlaces.apiKey(),
      'X-Goog-FieldMask': ADDRESS_FIELD_MASK,
    },
    body: JSON.stringify({ textQuery, maxResultCount: 1 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`places.searchText (address): ${res.status} ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as { places?: { id: string; addressComponents?: AddressComponent[] }[] };
  const p = data.places?.[0];
  if (!p) return null;

  const components = p.addressComponents ?? [];
  const streetNumber = pickComponent(components, 'street_number');
  // shortText ("Ln" not "Lane") matches how NAP addresses are conventionally
  // written for Google Business Profile / local listings.
  const route = pickComponent(components, 'route', true);
  const subpremise = pickComponent(components, 'subpremise');
  const streetLine = [streetNumber, route].filter(Boolean).join(' ');
  const street = subpremise ? [streetLine, `Ste ${subpremise}`].filter(Boolean).join(', ') : streetLine || undefined;
  const city = pickComponent(components, 'locality') ?? pickComponent(components, 'sublocality') ?? pickComponent(components, 'postal_town');
  const state = pickComponent(components, 'administrative_area_level_1', true);
  const zip = pickComponent(components, 'postal_code');

  return {
    street,
    city,
    state,
    zip,
    placeId: p.id,
    complete: Boolean(street && city && state && zip),
  };
}

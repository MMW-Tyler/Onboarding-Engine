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

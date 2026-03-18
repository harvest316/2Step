# Additional Review Sources by Country

## Current: Google Maps only (via Outscraper)

Google Maps is dominant globally, but supplementing with country-specific
platforms would find more prospects and more reviews per prospect.

## Priority sources to add

### Global

- Facebook Reviews — many businesses have active FB pages with reviews
- Outscraper supports FB scraping

### US

- Yelp — strong for local services/trades (Outscraper supports Yelp)
- BBB (Better Business Bureau) — trust signal, especially older demographics
- Angi / HomeAdvisor — trades-specific (plumber, HVAC, roofing, pest control)

### UK (when UK clips ready)

- Trustpilot — very popular in UK, often more reviews than Google Maps
- Checkatrade — UK trades-specific (plumber, electrician, builder)
- Yell.com — UK Yellow Pages with reviews

### AU

- hipages — AU trades marketplace with reviews
- ProductReview.com.au — general product/service reviews
- True Local — AU local business directory

### NZ

- NoCowboys — NZ trades directory with reviews
- Finda — NZ business directory

### CA

- HomeStars — CA trades-specific (like Checkatrade for Canada)

## Implementation approach

- Outscraper already supports Google Maps + Yelp + Facebook
- For platform-specific sites (Checkatrade, hipages), may need custom scrapers
- Reviews from different sources can use the same video pipeline
- Consider: merging reviews across sources for the same business (dedup by business name + address)

## Trigger

Add sources one at a time as we expand to each country.
Yelp (US) is the highest-impact next source.

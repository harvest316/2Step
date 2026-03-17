# 2Step TODO

## Pending

### Generate videos for remaining pest control prospects
All 15 pest control prospects now have pest-specific reviews. Run:
```
node src/video/prompt-generator.js --tool creatomate
node src/video/creatomate.js --dry-run   # verify
node src/video/creatomate.js
```

### Plumber + house cleaning verticals (prospects 17–37)
Still at `found` status — no logos, no videos queued. When ready to expand:
1. Run logo scraper / prompt-generator for these prospects
2. Generate Kling clips for any missing plumber/cleaning sub-niches
3. Queue creatomate renders

### Generic clips (future, if needed)
If future prospect imports produce reviews with no detectable pest keyword
(unlikely now that `outscraper.js` scores keyword reviews 1000pts higher),
generate ~10 generic pest clips (~80 Kling credits) and expand `detectPestFromReview`
to return `'generic-pest'` as a fallback pool key.

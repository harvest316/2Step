# 2Step TODO

## Blocked on Kling credits

### Generic pest clips (9 prospects blocked)
Prospects with generic reviews (no specific pest mentioned) are currently skipped by
`creatomate.js` because we have no suitable clips. Once credits are available, generate:

- **5× generic pest hook clips** — e.g. homeowner looking worried, bugs generically visible,
  "something's wrong" reaction shot
- **5× generic pest treatment clips** — technician with sprayer, general inspection, house exterior
- ~80 credits total (10 clips × 8 credits each)

Then re-run `prompt-generator.js --tool creatomate` for skipped prospects and clear this block.

**Blocked prospects (9):**
| ID | Business |
|----|----------|
| 1  | Pest Control Sydney Wide |
| 3  | BugFree Pest Control |
| 6  | Rentokil Pest Control Sydney |
| 8  | NSW Pest Control Sydney |
| 9  | Safe Pest Control Sydney |
| 10 | Masters Pest Control Sydney |
| 11 | Killmore Pest Control Services Sydney |
| 12 | Competitive Pest Services |
| 13 | Sydney Pest Crew |

**Note:** Review selection in `outscraper.js` now scores pest-keyword reviews higher so
future prospect imports should have fewer generics. Existing 9 are already in DB.

### Expand to other verticals
Once pest clips are done, repeat for plumber and house cleaning generics if needed.

# Country-Specific Kling Clip Generation

## Problem

Current clip pool (174 clips) features AU/US-appropriate visuals:
- Standalone homes (typical AU/US/CA/NZ)
- Local ethnicities
- Outdoor environments matching AU/US climate

UK terraced housing looks completely different — narrow front, joined walls,
small front garden. Using AU-style clips for UK prospects would look fake and
hurt conversion.

## Countries & Visual Requirements

- **AU, US, NZ**: current clips work well (standalone suburban homes, similar look)
- **CA**: mostly works — some northern/coastal CA architecture differs but
  standalone homes are the majority. Acceptable for launch.
- **UK**: BLOCKED until UK-specific clips generated
  - Terraced/semi-detached housing is the key difference
  - Anglo skin colour is fine across all English-speaking countries
  - UK weather/lighting (overcast, green gardens) is secondary
- **EU**: future consideration (apartment blocks, very different architecture)

## Requirements

- Generate Kling clips with UK-appropriate HOUSING only (terraced, semi-detached)
  - Ethnicity is not the differentiator — housing style is
- Tag clips with `country_group` in clip pool
- Clip selection logic: pick clips matching `site.country_code`
- Extend PROBLEM_CATEGORIES with country housing variants

## Trigger

Before targeting UK market. UK is excluded from keywords until clips exist.

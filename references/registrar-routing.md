# Registrar Routing Table

## Why This Exists

name.com doesn't support all TLDs. When a domain uses a TLD that name.com can't sell, the buy link must route to a registrar that can. This table defines where each TLD routes.

---

## Routing Logic

```
1. Check the domain's TLD against the "Fallback TLDs" list below
2. If TLD is in a fallback list → use that registrar's search URL
3. If TLD is not in any fallback list → use name.com (the default)
```

---

## Registrars

### name.com (Primary — default for all TLDs not listed below)

- **Commission:** 20%
- **Search URL:** `https://www.name.com/domain/search/{domain}`
- **Link text:** `Register on name.com →` or `Check manually on name.com →`

Covers: .com, .dev, .io, .ai, .co, .app, .xyz, .me, .sh, .cc, .am, .at, .be, .re, .es, .no, .se, .de, .in, .it, and all thematic gTLDs (.tools, .codes, .build, .run, .studio, .design, .art, .gallery, .ink, .media, .chat, .coffee, .cafe, .menu, .game, .quest, .lol, .ventures, .supply, .agency, .inc, .capital, .community, .social, .club, .group, .team, .shop, .store, .market, .deals, .academy, .school, .courses, .training, .health, .care, .clinic, .fit, .music, .band, .audio, .fm, .money, .finance, .fund, .tax, .investments).

---

### Dynadot (Fallback — ccTLDs not on name.com)

- **Commission:** 30% (Ambassador program)
- **Search URL:** `https://www.dynadot.com/domain/search?domain={domain}`
- **Link text:** `Register on Dynadot →` or `Check manually on Dynadot →`

**Fallback TLDs:** `.st`, `.ly`, `.is`, `.to`, `.pt`, `.my`, `.gg`, `.nu`

---

## Non-Registrable TLDs

These ccTLDs have no widely accessible public registrar. If a domain hack uses one and it appears available, add this note instead of a buy link:

> "Registration requires a specialty registrar — search for '.{tld} domain registration' for options."

**Non-registrable TLDs:** `.er`, `.al`

---

## Non-Public TLDs

These TLDs are controlled by corporations and not open for public registration at any registrar. Do not generate buy links for them. If they appear in the TLD catalog, skip them.

- `.bot` — Amazon (brand TLD, pending public release)
- `.play` — Google (brand TLD, not open)
- `.buy` — Amazon (brand TLD, not open)
- `.sound` — not an active delegated TLD

---

## Quick Reference

| TLD | Registrar | Search URL |
|-----|-----------|------------|
| `.st` | Dynadot | `https://www.dynadot.com/domain/search?domain={domain}` |
| `.ly` | Dynadot | `https://www.dynadot.com/domain/search?domain={domain}` |
| `.is` | Dynadot | `https://www.dynadot.com/domain/search?domain={domain}` |
| `.to` | Dynadot | `https://www.dynadot.com/domain/search?domain={domain}` |
| `.pt` | Dynadot | `https://www.dynadot.com/domain/search?domain={domain}` |
| `.my` | Dynadot | `https://www.dynadot.com/domain/search?domain={domain}` |
| `.gg` | Dynadot | `https://www.dynadot.com/domain/search?domain={domain}` |
| `.nu` | Dynadot | `https://www.dynadot.com/domain/search?domain={domain}` |
| `.er` | — | Non-registrable (specialty registrar only) |
| `.al` | — | Non-registrable (specialty registrar only) |
| Everything else | name.com | `https://www.name.com/domain/search/{domain}` |

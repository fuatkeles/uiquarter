# UIQuarter — Güncel Durum Özeti

## Proje Nedir?

UIQuarter, frontend projelerini **statik olarak analiz eden** bir TypeScript CLI aracıdır.

Amaç:
- UI bileşenlerini ve mimari pattern'leri çıkarmak
- Bileşenler arası bağımlılık ilişkilerini görmek
- Mimari riskleri/insight'ları tespit etmek
- AI araçları için (Claude/Codex/Cursor vb.) **token-verimli bağlam** üretmek
- Drift (mimari değişim) takibi yapmak
- MCP üzerinden AI araçlarına canlı sorgulanabilir context sağlamak

Kısacası: `uiquarter`, bir projeyi tarayıp `.uiq/` altında sorgulanabilir bir "mimari zeka katmanı" oluşturur.

---

## Şu Anki Haliyle Ne İşe Yarıyor?

Bugünkü haliyle UIQuarter ile:

1. `uiquarter init`
- Projeyi tarar, analyzer'ları çalıştırır, cache kullanır, index + insights üretir
- Schema migration kontrolü yapar
- Cache analyzer versiyon değişimlerine göre invalidation yapar
- `.uiq/index.json`, `.uiq/meta.json`, `.uiq/insights.json` üretir

2. `uiquarter query ...`
- Oluşan intelligence index üzerinde istatistik, component, dependency, insight sorguları yaparsın

3. `uiquarter resolve "..."` ve `uiquarter export --type scope`
- Serbest metin task'i (örn. "modal erişilebilirliğini düzelt") ilgili pattern/component'lere eşler
- Gerekirse task-scoped minimal context üretir (AI için daha kısa ve hedefli)

4. `uiquarter prompt` / `uiquarter generate`
- AI araçları için context/prompt veya kural dosyaları üretir
- Birden fazla hedef format destekler (CLAUDE.md, AGENTS.md, .cursorrules, vb.)

5. `uiquarter watch`
- Dosya değişikliklerini izler, cache invalidation + yeniden analiz + yeniden index/insight üretimi yapar

6. `uiquarter drift`
- Kaydedilmiş baseline ile mevcut `.uiq/` çıktısı arasında fark raporu üretir

7. `uiquarter serve`
- MCP (Model Context Protocol) sunucusu başlatır
- AI araçları stdio üzerinden component/query/scope context çağrıları yapabilir

---

## End-to-End Pipeline (Mevcut)

`uiquarter init` akışı:

1. **Schema Migration Check**
- `.uiq/` varsa schema versiyonunu kontrol eder
- Gerekiyorsa migration uygular

2. **FileDiscovery**
- Proje dosyalarını keşfeder
- ignore kuralları + deterministik sıralama + hash üretimi

3. **CacheLayer**
- Önceki hash/analyzer sonuçlarını yükler
- Corruption/incompatible durumda temiz rebuild'e düşer
- Analyzer version değişimlerine göre stale cache invalidation yapar

4. **AnalyzerOrchestrator**
- Analyzer dependency graph'ine göre çalıştırır
- `fileFilter` uygular
- Timeout + bounded concurrency + error isolation sağlar
- Per-analyzer timing toplar

5. **Normalizer**
- Analyzer çıktılarını canonical/deterministik formata normalize eder

6. **IntelligenceIndexer**
- Tüm pattern'leri birleştirir
- dependency edge'leri üretir
- `index.json`, `patterns/*.json`, `meta.json` yazar
- `meta.json` içine fingerprint + analyzer timing'leri koyar

7. **InsightEngine**
- Mimari insight'ları üretir (hub, orphan, cycle, deep chain, vb.)
- `insights.json` yazar

---

## Desteklenen Analyzer'lar (Şu An)

`init` pipeline'da aktif analyzer seti:

- `StructureAnalyzer` (legacy/stub tabanlı temel yapı sinyalleri)
- `ImportAnalyzer`
- `ComponentAnalyzer`
- `StylingAnalyzer`
- `FileStructureAnalyzer`
- `DependencyAnalyzer`
- `NextjsAnalyzer`
- `NuxtAnalyzer`
- `SvelteKitAnalyzer`
- `UxAnalyzer`

### UxAnalyzer (yeni kapsam)
Framework-agnostic UX/erişilebilirlik sinyalleri çıkarır:
- ARIA / role kullanımı
- error/loading/empty state pattern'leri
- responsive sinyaller
- navigation sinyalleri
- naming consistency / prefix tutarlılığı

---

## Query / AI Katmanı (Mevcut)

### QueryEngine
`.uiq/index.json` + `.uiq/insights.json` yükleyip şu işleri yapar:
- component bulma
- dependency / dependent sorgulama
- insight filtreleme
- stats
- resolver (inverted index + synonym + fuzzy)

### InvertedIndex + ResolverScorer
- Token tabanlı ters indeks
- Synonym eşleme
- Fuzzy eşleşme (edit distance)
- Skorlandırma (`exact/synonym/fuzzy`)
- `--debug` modunda token bazlı eşleşme nedenleri (`reasons`)

### ContextBuilder
- Projenin genel AI context'ini üretir (components, hubs, chains, insights)

### TaskScopedBuilder
- Task'e özel minimal context üretir
- Ana eşleşmeler + related bileşenler + ilgili insight'lar
- Karakter bütçesi ile kırpılabilir
- MCP ve `export --type scope` tarafından kullanılır

### PromptBuilder / BudgetPromptBuilder
- AI-uyumlu prompt çıktısı üretir
- Budget-aware (token tahmini bazlı) seçim yapabilir

---

## CLI Komutları (Şu An Aktif)

- `init` — tam analiz pipeline'ı
- `query` — index/insight sorguları
- `explain` — insan-okunur mimari özeti
- `prompt` — AI prompt/context çıktısı (`--budget`, `--format`)
- `resolve` — serbest metin task çözümleme (`--synonyms`, `--fuzzy`, `--debug`)
- `watch` — dosya izleme + yeniden analiz
- `export` — `context`, `resolve`, `scope` export
- `generate` — AI araç dosyaları üretimi
- `drift` — baseline karşılaştırma
- `serve` — MCP server (stdio)

Not:
- Ayrı `analyze` / `index` komutları kaldırıldı; bu iş `init` pipeline'ında birleşik yapılıyor.

---

## Generate / Export Kapsamı

### `generate` hedefleri
Şu an desteklenen çıktı hedefleri:
- `claude`
- `codex`
- `cursor`
- `windsurf`
- `cline`
- `copilot`
- `aider`

### `export` tipleri
- `context` — genel proje context'i
- `resolve` — resolver sonuçları
- `scope` — task-scoped minimal context

---

## MCP Server (Serve Komutu)

`uiquarter serve`, stdio üzerinden MCP sunucusu açar.

Temel kullanım:
- AI araçları `uiquarter serve` subprocess'i başlatır
- JSON-RPC ile tool/resource çağrıları yapar

Desteklenen ana MCP araçları (özet):
- component sorgulama
- dependency/dependent sorgulama
- task resolve
- task-scoped context alma
- insight/stat çekme

Bu sayede AI araçları tüm dokümanı yüklemek yerine ihtiyaç duyduğu context'i anlık alır.

---

## `.uiq/` Çıktı Yapısı (Mevcut)

Tipik çıktı:

```text
.uiq/
  index.json          # master intelligence index (schemaVersion dahil)
  meta.json           # intelligenceHash, generatedAt, toolVersion, schemaVersion, buildNumber, analyzerTimings
  insights.json       # architectural insights
  snapshot.json       # drift baseline (drift --save sonrası)
  patterns/           # per-pattern detay dosyaları
  cache/              # cache (hashler + analyzer results + cache meta)
```

---

## Test Durumu (Güncel)

Doğrulanan durum:
- `npm run test` ✅ geçti
- `npm run test:vitest` ✅ geçti

Kapsanan alanlar (test dosyaları mevcut):
- core (FileDiscovery, Orchestrator, CacheLayer, Normalizer, Indexer, schema migration)
- analyzer'lar (temel + Next/Nuxt/SvelteKit + UX)
- insight engine
- query / resolver / debug scoring
- budget prompt
- CLI watch/export
- generate
- drift
- context builder + task-scoped builder
- MCP server

---

## Teknoloji Stack

- **Dil:** TypeScript (ESM)
- **CLI:** Commander
- **AST/Parsing:** ts-morph
- **Watch:** chokidar
- **Ignore parsing:** ignore
- **Build:** tsup
- **Test:** tsx tabanlı test koşuları + Vitest
- **Node:** >= 18

---

## Mevcut Durum Özeti (Tek Cümle)

UIQuarter şu anda bir frontend repo için analiz + mimari insight + resolver + AI context generation + drift detection + MCP üzerinden canlı sorgulanabilir context sağlayan, testleri geçen bir CLI/tooling altyapısıdır.

---

## Notlar / Bilinçli Trade-off'lar

- `init` üzerinde `--timeout` ve `--concurrency` var; orchestrator library fallback default'ları ayrıca korunuyor.
- `resolve` komutu task eşleşmesi yapar; budget kontrollü minimal context için `export --type scope` / `TaskScopedBuilder` kullanımı daha uygundur.
- Watch mode yeniden analiz akışı üretkendir; ultra-granüler incremental index section rebuild ayrı bir optimize katman olarak ileride geliştirilebilir.


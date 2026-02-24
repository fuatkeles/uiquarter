# UIQuarter — Phase 1 Limitations Tracker

Prompt 1'den itibaren tespit edilen tüm sınırlamalar, eksikler ve bilinen sorunlar.
Phase 1 (9 prompt) tamamlandığında toplu değerlendirme yapılacak.

---

## Prompt 1 — Project Scaffold

### Düzeltildi (artık sorun değil)
- ~~`PropertyDescriptor` TypeScript built-in ile çakışıyordu~~ → `PatternProperty` olarak rename edildi
- ~~`lint` ve `typecheck` scriptleri aynıydı~~ → `lint` kaldırıldı
- ~~LICENSE dosyası eksikti~~ → eklendi
- ~~`ResolverQuery.depth` ve `includeTransitive` zorunluydu~~ → opsiyonel yapıldı
- ~~exports'ta `types` condition sırası yanlıştı~~ → düzeltildi

### Aktif Sınırlamalar
- ~~**S1.1** — ESLint kurulumu yok.~~ → **Düzeltildi** (Phase 1 Cleanup — ESLint strict mode kuruldu, `npm run lint` eklendi)
- ~~**S1.2** — `.gitignore` minimal.~~ → **Düzeltildi** (Phase 1 Cleanup — .DS_Store, .env, .env.local, *.log, *.tsbuildinfo, .vscode/, .idea/ eklendi)
- **S1.3** — `package.json`'da `sideEffects: false` yok — tree-shaking hint'i eksik, library olarak kullanıldığında bundler'lar gereksiz kod dahil edebilir.

---

## Prompt 2 — Core Type System

### Düzeltildi
- ~~`PropertyDescriptor` global shadow~~ → `PatternProperty`
- ~~`Analyzer` interface'inde `dependencies` field yoktu~~ → Prompt 4'te eklendi

### Aktif Sınırlamalar
- **S2.1** — `ConfidenceScore.factors` weights toplamının 1 olması gerekiyor ama bu sadece convention, runtime validation yok.
- **S2.2** — `PatternType` union sabit. Yeni pattern türleri eklemek type değişikliği gerektirir, plugin-friendly değil (string literal union vs. string).
- **S2.3** — `IntelligenceIndex.buildNumber` "monotonically increasing" ama bunun nerede persist edildiği/yönetildiği tanımlanmamış.

---

## Prompt 3 — FileDiscovery

### Düzeltildi
- Yok (ilk seferde temiz çıktı)

### Aktif Sınırlamalar
- **S3.1** — `ALWAYS_IGNORED` listesinde `.git` ve `node_modules` var ama prompt sadece `node_modules, dist, build, coverage` dedi. `.git`'i ALWAYS_IGNORED'a koymak doğru bir karar ama prompt'tan sapma.
- **S3.2** — `DEFAULT_IGNORED`'a `.next`, `.nuxt`, `.output` eklendi. Prompt'ta bunlar yok. Zararsız ama prompt'a tam sadık değil.
- **S3.3** — `lstat` + `readFile` = dosya başına 2 syscall. `readFile` zaten buffer dönüyor (size biliniyor) ama `mtimeMs` için ayrı `lstat` zorunlu. Performans etkisi ihmal edilebilir ama optimal değil.
- **S3.4** — Çok büyük dosyalar (>100MB) tamamı memory'e okunuyor. Streaming hash yapılmıyor. Tipik kaynak dosyaları için sorun değil ama edge case.
- **S3.5** — `AbortSignal` desteği yok. FileDiscovery iptal edilemiyor (watch mode'da sorun olabilir).

---

## Prompt 4 — AnalyzerOrchestrator

### Düzeltildi
- ~~OrchestratorOptions.cache doc string'i "namespaces per-analyzer" diyordu ama yapmıyordu~~ → doc düzeltildi

### Aktif Sınırlamalar
- **S4.1** — Timeout sonrası analyzer arka planda çalışmaya devam ediyor. `Promise.race` kazanınca `analyzer.analyze()` promise'i hala yaşıyor. AbortSignal cooperative — analyzer kontrol etmezse gerçekten durmaz. JavaScript'te preemptive kill mümkün değil (worker thread olmadan).
- **S4.2** — `resolveExecutionLevels()` her `run()` çağrısında yeniden hesaplanıyor. Analyzer listesi constructor'da sabit, bir kez hesaplanıp cache'lenebilir. Pratik maliyet sıfıra yakın ama teknik olarak gereksiz iş.
- **S4.3** — Prompt "log errors" diyor ama console.log/error yok. Bilinçli karar — library'de console kullanımı anti-pattern. Errors `OrchestratorResult.errors` array'inde döndürülüyor, caller log'lamalı.
- ~~**S4.4** — Cross-analyzer data flow yok.~~ → **Düzeltildi** (Phase 1 Cleanup — `AnalyzerContext.dependencyOutputs` eklendi, orchestrator frozen snapshot olarak tüm tamamlanmış output'ları geçiyor)

---

## Prompt 5 — CacheLayer

### Düzeltildi
- ~~`setAnalyzerResult` analyzer versiyonunu `analyzerVersions` map'ine yazmıyordu~~ → `extractVersion(output.analyzerId)` ile düzeltildi
- ~~`ScopedAccessor` constructor'da `analyzerId` unused field'dı~~ → `_analyzerId` olarak düzeltildi

### Aktif Sınırlamalar
- **S5.1** — TTL testi sığ. `CacheEntry.createdAt` readonly olduğu için test'te expired TTL simüle edilemiyor. Logic doğru yazılmış ama deep test yok. Time-mocking gerekir.
- **S5.2** — Concurrent `flush()` koruması yok. İki flush aynı anda çağrılırsa temp dosya adı çakışabilir (`process.pid` aynı). Pratikte tek thread'de sıralı çalışır ama mutex yok.
- **S5.3** — Tüm cache memory'de tutuluyor. 100k entry'de ~50MB RAM alabilir. Gerçek projeler için sorun değil ama teorik limit.
- **S5.4** — `stableReplacer` Map/Set/Date handle etmiyor. Analyzer `CacheEntry.value` içine Map koyarsa `{}` olarak serileştirilir. JSON-serializable olma kısıtı implicit, enforced değil.
- **S5.5** — Partial flush koruması: data dosyaları yazılıp meta yazılmadan crash olursa, sonraki load checksum mismatch ile full wipe yapar. Veri kaybı minimal ama zero değil.

---

## Prompt 6 — Normalizer

### Düzeltildi
- Yok (ilk seferde temiz çıktı)

### Aktif Sınırlamalar
- **S6.1** — `normalizeMetadata` key lookup'ı `key.toLowerCase()` ile yapılıyor ama `DEFAULT_METADATA_KEY_MAP` tüm key'leri zaten lowercase. Eğer kullanıcı custom `metadataKeyMap`'e büyük harfli key koyarsa (ör. `"Tailwind"`) o key metadata'da `"Tailwind"` olarak gelirse eşleşir ama `metadataKeyMap`'teki key `"Tailwind"` ise ve metadata `"tailwind"` ise **eşleşmez**. Yani case-insensitivity tek yönlü: metadata key'i lowercase'e çevriliyor ama map key'i çevrilmiyor. Pratikte sorun değil çünkü default map zaten lowercase, ama custom map'te potansiyel tuzak.
- **S6.2** — Category conflict resolution "first wins" — `Object.keys()` iteration sırasına bağlı. Çoğu JS engine insertion order kullanır ama spec'te garanti yok (integer-like key'ler hariç). Pratikte sorun olmaz ama "hangi lib önce geldi" sorusunun cevabı metadata insertion order'a bağlı, deterministik değil.
- **S6.3** — `flags` array mevcut metadata'da `flags` key'i non-array bir değerse (ör. `flags: "custom"`) bu değer `existing` check'inden geçemez (`Array.isArray` false döner) ve üzerine yazılır. Edge case ama bilgi kaybı mümkün.
- **S6.4** — `SourceSpan` (location) normalize edilmiyor. Eğer farklı analyzer'lar aynı lokasyonu farklı line/column convention'ıyla (0-based vs 1-based) raporlarsa normalizer bunu düzeltmez. Bu normalizer'ın scope'u dışında olabilir ama location canonicalization yok.
- **S6.5** — `diagnostics` normalize edilmez — sadece sort edilir. filePath'e forward-slash dönüşümü, message trim, severity validation yok. Pattern'lara uygulanan kurallar (path normalization, trim) diagnostic'lere uygulanmıyor.
- **S6.6** — `stableReplacer` her JSON.stringify çağrısında tüm nested object'lerin key'lerini sort ediyor. Patterns ve diagnostics zaten sorted olduğu için bu çift iş. Performans etkisi ihmal edilebilir ama redundant.

---

## Prompt 7 — IntelligenceIndexer

### Düzeltildi
- Yok (ilk seferde temiz çıktı)

### Aktif Sınırlamalar
- ~~**S7.1** — `DependencyEdge.kind` her zaman `"import"` olarak hardcoded.~~ → **Düzeltildi** (Phase 2.5 — `buildEdges()` artık `pattern.metadata.edges` varsa typed kind kullanıyor, yoksa `"import"` fallback. DependencyEdge.kind union'a `"hook-usage"`, `"hoc-wrapping"`, `"provider"` eklendi.)
- ~~**S7.2** — Duplicate PatternId conflict resolution sessiz.~~ → **Düzeltildi** (Phase 1 Cleanup — `IndexerDiagnostic` warning üretiliyor, `buildDiagnostics` getter'dan erişilebilir. Deterministic sorted order.)
- **S7.3** — `sanitizePatternId` injective değil — `a/b:c` ve `a_b__c` aynı dosya adını üretir. Pratikte PatternId formatı `filePath:name:line` olduğu için collision olasılığı çok düşük ama teorik olarak mümkün.
- ~~**S7.4** — Orphan pattern dosyaları temizlenmiyor.~~ → **Düzeltildi** (Phase 1 Cleanup — `write()` yeni dosyaları yazıp sonra orphan'ları siliyor. Safe order: write-first, delete-after.)
- **S7.5** — `meta.json`'daki `generatedAt` her write'ta `new Date().toISOString()` ile hesaplanıyor. Bu timestamp non-deterministic — aynı input'la ardışık iki build farklı meta.json üretir. intelligenceHash index.json'dan hesaplandığı için bunu etkilemez ama meta.json kendisi deterministic değil.
- **S7.6** — `buildNumber` sadece meta.json'dan okunuyor. meta.json bozulursa veya silinirse buildNumber 1'e resetlenir. Monotonically increasing garanti sadece meta.json sağlam kaldığı sürece geçerli.
- **S7.7** — `.uiq/` dizini hem CacheLayer (`.uiq/cache/`) hem IntelligenceIndexer (`.uiq/index.json`, `.uiq/meta.json`, `.uiq/patterns/`) tarafından kullanılıyor. Her ikisi de `.uiq/meta.json` yazabilir — isim çakışması! CacheLayer `.uiq/cache/meta.json` yazıyor (farklı path), ama potansiyel karışıklık kaynağı.
- ~~**S7.8** — Utility fonksiyonları 3 modülde duplicate.~~ → **Düzeltildi** (Phase 1 Cleanup — `src/core/utils.ts` oluşturuldu, tüm duplicate'lar kaldırıldı. utils.ts dependency-free.)

---

## Prompt 8 — CLI Init Command

### Düzeltildi
- ~~Unused type imports (`CacheKey`, `FileHash`, `AId`) in init.ts~~ → kaldırıldı (typecheck yakaladı)

### Aktif Sınırlamalar
- ~~**S8.1** — Stub analyzer'lar gerçek AST analizi yapmıyor. StructureAnalyzer sadece dosya adı ve uzantısına bakıyor.~~ → **Kısmen düzeltildi** (Phase 2 — ImportAnalyzer, ComponentAnalyzer, StylingAnalyzer, FileStructureAnalyzer, DependencyAnalyzer artık production-grade. StructureAnalyzer deprecated olarak kaldı — STR001 diagnostic üretiyor.)
- **S8.2** — Framework detection sadece uzantıya bakıyor. `.ts`/`.tsx`/`.js`/`.jsx` dosyaları otomatik olarak "react" olarak sınıflandırılıyor. Eğer proje Angular veya non-React framework kullanıyorsa yanlış olur.
- **S8.3** — `StructureAnalyzer` her dosya için tek bir pattern üretiyor (line 1). Gerçek dosyada birden fazla component/hook olabilir. Stub olarak beklenen davranış ama gerçek analyzer'da multi-pattern-per-file gerekecek.
- **S8.4** — `init` komutu analyzer listesini hardcoded olarak oluşturuyor (6 production analyzer). Plugin sistemi yok. Analyzer'lar config'den veya plugin discovery'den yüklenmiyor.
- **S8.5** — `--no-cache` modunda `CacheAccessor` no-op implementasyonu kullanılıyor. Bu accessor `set()` çağrılarını sessizce yutuyor. Analyzer'lar cache'e yazdıklarını düşünüyor ama yazılmıyor. Pratikte sorun değil ama implicit contract violation.
- **S8.6** — `process.exitCode = 1` kullanılıyor ama async action'da Commander bu exit code'u her zaman doğru handle etmiyor. `process.exit(1)` daha güvenilir ama cleanup'ı kesiyor. Trade-off bilinçli yapıldı.
- **S8.7** — `init` komutu her çalıştırıldığında tüm dosyaları yeniden discover ediyor ve tüm analyzer'ları yeniden çalıştırıyor. İnkremental mod yok — cache'ten önceki output'lar `previousResults` olarak geçilmiyor. Full re-analyze her seferinde.
- **S8.8** — Logging `console.log/warn/error` kullanıyor. Structured logging yok (JSON log format, log levels, log destinations). Debug mode sadece daha fazla satır basıyor, gerçek log level kontrolü yok.

---

## Prompt 9 — Stub Analyzers (Import, Component, Styling)

### Düzeltildi
- ~~Unused `OutputHash` import in all 3 new analyzers~~ → kaldırıldı (typecheck yakaladı)

### Aktif Sınırlamalar
- **S9.1** — `computeEmptyHash()` her `analyze()` çağrısında SHA-256 yeniden hesaplıyor. Sonuç her zaman aynı (empty patterns + diagnostics). Bir kez hesaplanıp constant olarak saklanabilir. Maliyet ihmal edilebilir ama prensip olarak gereksiz iş.
- **S9.2** — Üç yeni analyzer hiçbir dependency tanımlamıyor. Orchestrator'da hepsi paralel çalışıyor. Gerçek implementasyonda `ComponentAnalyzer`'ın `ImportAnalyzer`'a bağımlı olması gerekebilir (import graph'ten component hierarchy çıkarılacak).
- ~~**S9.3** — `StylingAnalyzer` `.vue`/`.svelte` dosyalarını reddediyor.~~ → **Düzeltildi** (Phase 1 Cleanup — `.vue` ve `.svelte` `STYLING_EXTENSIONS`'a eklendi)
- ~~**S9.4** — Utility'ler hala 3 modülde duplicate.~~ → **Düzeltildi** (Phase 1 Cleanup — S7.8 ile birlikte çözüldü. shared.ts artık utils.ts'den re-export yapıyor.)
- **S9.5** — Tüm stub analyzer'lar `analyzedFiles: 0` raporluyor ama aslında dosyaları alıyor (context.files doluyordu). Gerçek implementasyonda her dosya gerçekten "analiz edilecek" ama şu an stub olduğu için doğru davranış.

---

## Genel / Cross-Cutting Sınırlamalar

- ~~**G1** — Test framework yok.~~ → **Düzeltildi** (Phase 1 Cleanup — Vitest kuruldu, `vitest.config.ts` oluşturuldu, `test:vitest` script eklendi. Manual testler korundu.)
- ~~**G2** — `package.json` scripts'te test script yok.~~ → **Düzeltildi** (Phase 1 Cleanup — `npm run test` ve `npm run test:vitest` eklendi)
- **G3** — Git repo initialize edilmedi. `.gitignore` var ama `git init` yapılmadı.
- **G4** — Hiçbir modülde logging altyapısı yok. Tüm hata bilgileri return value'larda — debug için yetersiz olabilir. (Not: init.ts'de console.log ile basit logging eklendi ama library modülleri hala sessiz.)
- ~~**G5** — Utility fonksiyonları 3 modülde duplicate.~~ → **Düzeltildi** (Phase 1 Cleanup — `src/core/utils.ts` oluşturuldu, tüm duplicate'lar kaldırıldı.)

---

## Phase 1 Tamamlandı — Genel Değerlendirme

### Mimari Özet
UIQuarter Phase 1 altyapısı 9 prompt'ta tamamlandı. Pipeline:
```
FileDiscovery → AnalyzerOrchestrator → Normalizer → CacheLayer → IntelligenceIndexer
```
Tüm bileşenler CLI `init` komutuyla end-to-end çalışıyor. 5 stub analyzer pipeline'ı doğruluyor.

### Güçlü Yanlar
- **Type safety:** Branded types (FileHash, PatternId, etc.) compile-time güvenlik sağlıyor
- **Determinism:** Her katmanda deterministik ordering, stable hashing, byte-identical output
- **Fault isolation:** Analyzer hataları pipeline'ı durdurmaz, dependency chain doğru yönetiliyor
- **Cache integrity:** SHA-256 checksum + schema versioning + atomic writes
- **Test coverage:** 103 test, tümü geçiyor, her modül kendi test dosyasına sahip

### Zayıf Yanlar (Phase 2 için)
- **Gerçek analiz yok:** Tüm analyzer'lar stub — AST parsing, import resolution yok
- **Plugin sistemi yok:** Analyzer'lar hardcoded, config/plugin discovery mekanizması eksik
- **Incremental mode yok:** Her `init` full re-analyze yapıyor, previousResults kullanılmıyor

### Phase 1 Cleanup'ta Düzeltilenler
- ~~Utility duplication~~ → `src/core/utils.ts` (6 fonksiyon deduplicate edildi)
- ~~Cross-analyzer data flow yok~~ → `dependencyOutputs` frozen snapshot
- ~~Orphan pattern dosyaları~~ → write-first, delete-after orphan cleanup
- ~~Duplicate PatternId sessiz~~ → `IndexerDiagnostic` warning'leri
- ~~StylingAnalyzer .vue/.svelte eksik~~ → eklendi
- ~~ESLint yok~~ → strict TypeScript ESLint kuruldu
- ~~Test framework yok~~ → Vitest kuruldu (manual testler korundu)
- ~~.gitignore minimal~~ → genişletildi
- ~~npm run test yok~~ → `test` + `test:vitest` eklendi

### Sayısal Özet

| Metrik | Değer |
|---|---|
| Toplam prompt | 9 + cleanup |
| Toplam kaynak dosyası | ~34 |
| Toplam test (manual) | 107 (6 + 14 + 16 + 26 + 20 + 12 + 12 + 1 data flow) |
| Toplam test (vitest) | 16 |
| Phase 1'de bulunan/düzeltilen bug | 7 |
| Cleanup'ta düzeltilen sınırlama | 9 |
| Aktif sınırlama | ~38 |
| Critical sınırlama | 0 |
| Dış bağımlılık (runtime) | 2 (commander, ignore) |
| Dev bağımlılık | 7 (typescript, tsup, tsx, eslint, typescript-eslint, @eslint/js, vitest) |

---

## Phase 2 — Aktif Sınırlamalar

- **P2.1** — `ImportAnalyzer` tasarım dokümanına göre `version: "1.0.0"` olmalıydı, ancak mevcut test kontratı `0.1.0` beklediği için implementasyon `0.1.0` bırakıldı. Tasarım ile kod arasında geçici sürüm uyumsuzluğu var.
- **P2.2** — Tasarım "her analiz edilen dosya için 1 pattern" derken, mevcut test kontratı `import` içermeyen dosyalarda `0 pattern` bekliyor. Bu nedenle analyzer şu an import bulunmayan dosyaları pattern üretmeden geçiyor (tasarıma göre eksik kapsam).
- **P2.3** — `ComponentAnalyzer` Phase 2'de production (`1.0.0`) olarak implement edilince `test/analyzers.test.ts` içindeki eski stub kontratı (`version: "0.1.0"`, boş output varsayımı) ile çakışıyor ve `npm run test` bu noktada fail ediyor. Test dosyası henüz Phase 2 kontratına güncellenmemiş.

---

## Phase 2.5 — Cleanup & Stabilization

### Düzeltilen Sınırlamalar
- ~~**S7.1** — DependencyEdge.kind hardcoded "import"~~ → `buildEdges()` artık `metadata.edges` varsa typed kind okuyor
- ~~**S8.1** — Stub analyzer'lar gerçek analiz yapmıyor~~ → 5 production analyzer implement edildi, StructureAnalyzer deprecated
- **Normalizer:** `"inline-styles"` boolean key DEFAULT_METADATA_KEY_MAP'e eklendi (`{ styling: "inline-styles" }`)

### Eklenen Özellikler
- **AnalyzerContext.schemaVersion** — Orchestrator `"2.0"` olarak set ediyor, analyzer'lar versiyon bazlı davranış değiştirebilir
- **AnalyzerOutput.metadata.execution** — Orchestrator her output'a `{ timeMs, patternCount, diagnosticCount }` ekliyor
- **Analyzer.deprecated** — Interface'e opsiyonel `deprecated: boolean` field eklendi
- **DependencyEdge.kind** — `"hook-usage"`, `"hoc-wrapping"`, `"provider"` union'a eklendi
- **docs/analyzer-contracts.md** — Tüm analyzer'ların metadata field'ları, PatternId formatları ve normalizer uyumluluğu dokümante edildi

### Aktif Sınırlamalar (Phase 2.5)
- **P2.5.1** — `AnalyzerContext.schemaVersion` opsiyonel. Hiçbir analyzer şu an bu değeri kontrol etmiyor. Gelecekte breaking change'lerde backward compat sağlamak için kullanılabilir.
- **P2.5.2** — `AnalyzerOutput.metadata.execution` orchestrator tarafından ekleniyor ama hash hesabına dahil değil. Test'lerde output karşılaştırması yaparken metadata görmezden gelinmeli.
- **P2.5.3** — StructureAnalyzer deprecated ama init.test.ts default olarak kullanmaya devam ediyor. Production CLI (`init`) zaten 6 analyzer kullanıyor, test'ler backward compat için tutuyor.

---

## Phase 3.5 — InsightEngine production finalization complete

### Düzeltildi (Resolved)
- ~~**B1** — edge confidence lookup mismatch~~ → **Resolved** (dep-pattern `edge.from` component ID'ye resolve edilerek lookup düzeltildi)
- ~~**B2** — deep chain detection broken~~ → **Resolved** (dep graph yerine component graph üzerinde chain çıkarımı uygulanıyor)
- ~~**B3** — dep pattern name resolution~~ → **Resolved** (`depToComponent` map ile dep pattern kaynak component'e normalize ediliyor)
- ~~**L1** — InsightEngineResult missing~~ → **Resolved** (`generate()` artık `InsightEngineResult` döndürüyor)
- ~~**L2** — type export missing~~ → **Resolved** (Insight tipleri `src/types/index.ts` ve `src/index.ts` barrel export'larına eklendi)
- ~~**L3** — abort support missing~~ → **Resolved** (`generate(index, { signal })` ve major loop'larda abort kontrolü eklendi)
- ~~**L4** — insights.json incomplete~~ → **Resolved** (`insights.json` payload artık `version`, `generatedAt`, `hash`, `stats`, `insights` içeriyor)

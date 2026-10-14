# ReportSpec reference

Authoritative schema: `report-anything schema`. This page is the cheat sheet.

## Shape

```jsonc
{
  "title": "2026 H1 revenue",            // required
  "subtitle": "…", "summary": "markdown with {{templates}}",
  "meta": { "author": "…", "date": "2026-07-03", "audience": "executive", "locale": "ko-KR", "currency": "KRW" },
  "page": { "size": "A4", "orientation": "portrait", "targetPages": 3 },
  "theme": { "palette": ["#1f4e79", "…"], "density": "compact" },
  "datasets": { "<id>": Dataset },
  "sections": [{ "id": "…", "title": "…", "description": "…", "layout": "auto", "breakBefore": false, "blocks": [Block] }]
}
```

Ids: letters, digits, `_`, `-`; start with a letter; unique across sections and blocks. Dataset ids contain no dots.

## Datasets

Exactly one source: `rows` (flat objects) · `json` (any JSON; `path: "data.orders"`, `unnest: "items"`) · `csv` (text with header) · `from` (another dataset id). Then optional `transform: [...]`, `fields: [{ name, label, format, type }]`, `source` (citation).

| op | example |
| --- | --- |
| filter | `{ "op": "filter", "expr": "year(period) == 2026 and region != 'EU'" }` |
| derive | `{ "op": "derive", "as": "margin", "expr": "(revenue - cost) / revenue" }` |
| aggregate | `{ "op": "aggregate", "groupBy": ["region"], "measures": [{ "field": "revenue", "agg": "sum", "as": "revenue" }] }` |
| sort / limit | `{ "op": "sort", "by": ["-revenue"] }` · `{ "op": "limit", "count": 10 }` |
| top | `{ "op": "top", "n": 5, "by": "revenue", "field": "region", "othersLabel": "Other" }` |
| timeUnit | `{ "op": "timeUnit", "field": "created_at", "unit": "month", "as": "month" }` |
| window | `{ "op": "window", "fn": "pctChange", "field": "revenue", "as": "growth", "sortBy": "month" }` (cumsum, diff, pctChange, share, rank, movingAvg, rowNumber; `groupBy`) |
| fold / pivot | wide→long `{ "op": "fold", "fields": ["q1","q2"], "as": ["quarter","value"] }` · long→wide `{ "op": "pivot", "index": ["region"], "columns": "quarter", "values": "value" }` |
| bin | `{ "op": "bin", "field": "price", "bins": 10 }` → `price_bin`, `price_bin_end` |
| lookup | `{ "op": "lookup", "from": "customers", "on": ["customer_id", "id"], "fields": ["tier"] }` |
| select / rename | `{ "op": "select", "fields": ["a","b"] }` · `{ "op": "rename", "fields": { "amt": "amount" } }` |

Expressions: `+ - * / %`, `== != > >= < <=`, `and or not`, `'strings'`, `` `field with spaces` ``; functions `abs round floor ceil min max sqrt log pow coalesce if year quarter month day lower upper concat len contains`. Null propagates; division by zero is null.

Aggregations (`agg`): `sum avg min max count countDistinct median first last`.

## Formats

`number` · `number:2` · `integer` · `percent` / `percent:1` (expects ratios: 0.12 → 12%) · `currency` / `currency:KRW` / `currency:USD:2` · `compact` (1.2M, 1.2만) · `date` · `date:year|quarter|month|week|day` · `datetime` · `text`.

## Bound values

- Measure (KPI `value`/`compareTo`, comparison `values`): `{ "data": "sales", "field": "revenue", "agg": "sum", "where": "year(period) == 2026" }`.
- Template in any markdown: `{{sum(sales.revenue) | currency:KRW}}`, `{{count(orders)}}`, `{{last(monthly.growth) | percent}}`. Text before the first dot is the dataset id.

## Blocks

Common: `id`, `type`, `title`, `caption` (footnote/source), `sourceRefs`, `span` (avoid).

| type | fields |
| --- | --- |
| `text` | `content` (markdown: paragraphs, `- ` bullets, `1. `, `**bold**`, `*italic*`, `` `code` ``, templates) |
| `kpi` | `items[1..8]`: `label`, `value`, `format`, `compareTo` or `delta` (ratio), `deltaLabel`, `goodWhen: up|down`, `description`, `sparkline: { data, x, y }` |
| `chart` | `chart` (below), `height: sm|md|lg` |
| `table` | `data`, `columns: [{ field, label, format, align, emphasis: bar|heat|delta }]`, `sortBy`, `maxRows`, `totals: true | [fields]`, `density`, `paginate` |
| `callout` | `content`, `tone: neutral|info|positive|warning|critical`, `variant: insight|recommendation|note|risk` |
| `list` | `style: bullet|numbered|check`, `items: [{ text, detail, tag, tone }]` |
| `comparison` | `entities[2..4]`, `metrics: [{ label, values (one per entity), format, goodWhen }]`, `showDelta` |

## Charts

`{ "kind", "data", "x", "y", ... }` — duplicate x(/series) rows are aggregated with `aggregate` (default sum).

| kind | encoding |
| --- | --- |
| `bar` | `x` category/time, `y` one or more measures or `series` field; `stack: true|"percent"`, `horizontal`, `labels`, `sort: x|-x|y|-y`, `limit` + `others` |
| `line` / `area` | `x` time/number/category, `y` measure(s) or `series`; `curve: linear|monotone|step`; area supports `stack` |
| `scatter` | `x`, `y` numbers; `value` = bubble size; `series` for color |
| `pie` / `donut` | `x` category, single `y`; small slices merge into Other |
| `heatmap` | `x`, `y` categories, `value` measure |

Also: `secondary: { y, format, label }` (right-axis lines), `reference: [{ value, label, axis }]`, `xFormat`, `yFormat`, `xLabel`, `yLabel`, `legend`.

## Layout

Section `layout`: `auto` (default; content-driven) · `stack` 12 · `main-side` 8/4 · `side-main` 4/8 · `split` 6/6 · `thirds` 4/4/4 · `quarters` 3/3/3/3. Minimum widths (chart 300px, table 320px, text 220px) widen spans on narrow pages, so print and web layouts differ by design.

## Ops (JSONL, one per line; these apply cleanly to the example below)

```jsonl
{"op":"updateBlock","id":"trend","patch":{"chart":{"kind":"line"},"title":"Monthly revenue"}}
{"op":"addSection","section":{"id":"actions","title":"Next steps","blocks":[{"id":"todo","type":"list","items":[{"text":"Review EU pricing"}]}]}}
{"op":"addBlock","section":"summary","after":"kpis","block":{"id":"risk","type":"callout","variant":"risk","tone":"warning","content":"MoM growth was {{last(monthly.growth) | percent}}."}}
{"op":"moveBlock","id":"risk","section":"actions","before":"todo"}
{"op":"replaceBlock","id":"trend","block":{"id":"trend","type":"table","data":"monthly"}}
{"op":"setReport","patch":{"subtitle":null}}
```

## Example

```json
{
  "title": "Q2 sales",
  "meta": { "locale": "en-US", "currency": "USD" },
  "datasets": {
    "sales": { "csv": "month,region,revenue\n2026-04,EU,120\n2026-04,US,200\n2026-05,EU,130\n2026-05,US,190\n2026-06,EU,150\n2026-06,US,210", "source": "warehouse.sales" },
    "monthly": {
      "from": "sales",
      "transform": [
        { "op": "aggregate", "groupBy": ["month"], "measures": [{ "field": "revenue", "agg": "sum", "as": "revenue" }] },
        { "op": "window", "fn": "pctChange", "field": "revenue", "as": "growth", "sortBy": "month" }
      ],
      "fields": [{ "name": "month", "format": "date:month" }, { "name": "revenue", "label": "Revenue", "format": "currency" }, { "name": "growth", "label": "MoM", "format": "percent" }]
    }
  },
  "sections": [
    {
      "id": "summary",
      "title": "Summary",
      "blocks": [
        { "id": "kpis", "type": "kpi", "items": [
          { "label": "June revenue", "value": { "data": "monthly", "field": "revenue", "agg": "last" }, "compareTo": { "data": "monthly", "field": "revenue", "where": "month == '2026-05'" }, "format": "currency", "deltaLabel": "vs May" }
        ] },
        { "id": "trend", "type": "chart", "title": "Revenue by month", "chart": { "kind": "bar", "data": "monthly", "x": "month", "y": "revenue", "secondary": { "y": "growth", "format": "percent", "label": "MoM" } } },
        { "id": "why", "type": "callout", "variant": "insight", "content": "EU grew fastest; June closed at {{last(monthly.revenue) | currency}}." }
      ]
    }
  ]
}
```

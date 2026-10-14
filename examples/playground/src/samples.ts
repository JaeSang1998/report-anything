import type { Row } from "@report-anything/core";

/** Deterministic PRNG so screenshots are stable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const REGIONS = ["서울", "경기", "부산", "대구", "광주"];
const CHANNELS = ["온라인", "매장", "B2B"];

export function salesRows(): Row[] {
  const rand = rng(42);
  const rows: Row[] = [];
  for (let m = 0; m < 18; m++) {
    const year = 2025 + Math.floor(m / 12);
    const month = (m % 12) + 1;
    const period = `${year}-${String(month).padStart(2, "0")}-01`;
    REGIONS.forEach((region, ri) => {
      CHANNELS.forEach((channel, ci) => {
        const base = [9, 6.5, 4, 2.6, 2][ri]! * [1.3, 1, 0.6][ci]! * 1e8;
        const trend = 1 + m * (ci === 0 ? 0.03 : 0.012);
        const season = 1 + 0.12 * Math.sin((month / 12) * Math.PI * 2);
        const revenue = Math.round(base * trend * season * (0.9 + rand() * 0.2));
        rows.push({
          period,
          region,
          channel,
          revenue,
          cost: Math.round(revenue * (0.58 + rand() * 0.08 - (ci === 0 ? 0.04 : 0))),
          orders: Math.round(revenue / (ci === 2 ? 2.4e6 : 6.5e4)),
        });
      });
    });
  }
  return rows;
}

function nestedOrders(): unknown {
  const rand = rng(7);
  const tiers = ["gold", "silver", "bronze"];
  const countries = ["KR", "JP", "US", "DE"];
  const skus = [
    { sku: "PRO-01", price: 129 },
    { sku: "STD-02", price: 59 },
    { sku: "LITE-03", price: 19 },
    { sku: "ADD-04", price: 9 },
  ];
  const orders = Array.from({ length: 120 }, (_, i) => {
    const items = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
      const p = skus[Math.floor(rand() * skus.length)]!;
      return { sku: p.sku, qty: 1 + Math.floor(rand() * 4), price: p.price };
    });
    const day = 1 + Math.floor((i / 120) * 180);
    const date = new Date(Date.UTC(2026, 0, day));
    return {
      id: `ord_${1000 + i}`,
      created_at: date.toISOString(),
      status: rand() > 0.12 ? "paid" : "refunded",
      customer: { name: `Customer ${i % 37}`, tier: tiers[Math.floor(rand() * 3)], country: countries[Math.floor(rand() * 4)] },
      items,
      total: items.reduce((s, it) => s + it.qty * it.price, 0),
    };
  });
  return { meta: { page: 1, total: orders.length }, data: { orders } };
}

export const nestedApiPayload = nestedOrders();

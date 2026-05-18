import React from "react";
export default function VisionHealPanel({ count = 0, costUsd = 0, strategy = { pixelmatch: 0, llm: 0 } }) {
  return <div className="card card-padded mb-lg"><h2 className="section-title">Vision healing</h2><p className="text-sm">Heals: {count} · Cost: ${Number(costUsd||0).toFixed(2)} · Pixelmatch: {strategy.pixelmatch||0} · LLM: {strategy.llm||0}</p></div>;
}

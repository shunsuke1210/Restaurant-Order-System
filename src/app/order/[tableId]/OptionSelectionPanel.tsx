"use client";

import { useState } from "react";
import type {
  MenuItemOption,
  MenuItemView,
} from "@/lib/gateways/customerOrderingGateway";
import { formatYen } from "./formatYen";

export type OptionValue = string | boolean | number;

export type ItemSelection = {
  optionSelections: Readonly<Record<string, OptionValue>>;
  quantity: number;
};

type OptionSelectionPanelProps = {
  item: MenuItemView;
  onCancel: () => void;
  onConfirm: (selection: ItemSelection) => void;
};

function buildDefaultSelections(
  options: MenuItemView["options"],
): Record<string, OptionValue> {
  const defaults: Record<string, OptionValue> = {};
  for (const option of options) {
    defaults[option.id] = option.default;
  }
  return defaults;
}

/**
 * 品目タップ後に開くオプション選択パネル（要件1.6）。
 *
 * design.mdのMenuItemOption判別共用体（choice/toggle/counter）ごとに
 * mock-preview.html（detailModalHtml関数）が検証済みのUIパターン
 * （choiceはボタン群、toggleはスイッチ、counterは+/-ステッパー）を
 * Reactコンポーネントとして実装する。
 *
 * 本タスク（6.1）のスコープは「選択内容をローカルstateへ保持する」までで、
 * 実際の注文送信（submitOrder呼び出し）は6.2の責務。「選択を確定」ボタンは
 * 選択結果を親（MenuScreen）へ渡すのみで、どこにも送信しない。
 */
export default function OptionSelectionPanel({
  item,
  onCancel,
  onConfirm,
}: OptionSelectionPanelProps) {
  const [selections, setSelections] = useState<Record<string, OptionValue>>(
    () => buildDefaultSelections(item.options),
  );
  const [quantity, setQuantity] = useState(1);

  function setChoice(optionId: string, choice: string) {
    setSelections((prev) => ({ ...prev, [optionId]: choice }));
  }

  function toggleOption(optionId: string) {
    setSelections((prev) => ({ ...prev, [optionId]: !prev[optionId] }));
  }

  function stepCounter(
    option: Extract<MenuItemOption, { type: "counter" }>,
    delta: number,
  ) {
    setSelections((prev) => {
      const current =
        typeof prev[option.id] === "number"
          ? (prev[option.id] as number)
          : option.default;
      const next = Math.min(option.max, Math.max(option.min, current + delta));
      return { ...prev, [option.id]: next };
    });
  }

  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-black/40 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${item.name}のオプション選択`}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl"
      >
        <p className="text-base font-semibold text-neutral-900">
          {item.name}
        </p>
        <p className="mb-4 text-sm text-neutral-500">
          {formatYen(item.price)}
        </p>

        {item.options.map((option) => (
          <div key={option.id} className="mb-4">
            <p className="mb-1.5 text-sm font-medium text-neutral-700">
              {option.label}
            </p>

            {option.type === "choice" ? (
              <div role="group" aria-label={option.label} className="flex flex-wrap gap-2">
                {option.choices.map((choice) => {
                  const pressed = selections[option.id] === choice;
                  return (
                    <button
                      key={choice}
                      type="button"
                      aria-pressed={pressed}
                      onClick={() => setChoice(option.id, choice)}
                      className={
                        "rounded-full border px-3 py-1.5 text-sm " +
                        (pressed
                          ? "border-neutral-900 bg-neutral-900 text-white"
                          : "border-neutral-300 text-neutral-700")
                      }
                    >
                      {choice}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {option.type === "toggle" ? (
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(selections[option.id])}
                aria-label={option.label}
                onClick={() => toggleOption(option.id)}
                className={
                  "rounded-full px-3 py-1.5 text-sm " +
                  (selections[option.id]
                    ? "bg-neutral-900 text-white"
                    : "bg-neutral-100 text-neutral-600")
                }
              >
                {selections[option.id] ? "希望する" : "希望しない"}
              </button>
            ) : null}

            {option.type === "counter" ? (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label={`${option.label}を減らす`}
                  onClick={() => stepCounter(option, -1)}
                  disabled={(selections[option.id] as number) <= option.min}
                  className="h-8 w-8 rounded-full border border-neutral-300 text-lg leading-none disabled:opacity-30"
                >
                  −
                </button>
                <span
                  data-testid={`${option.id}-count`}
                  className="w-6 text-center tabular-nums"
                >
                  {selections[option.id]}
                </span>
                <button
                  type="button"
                  aria-label={`${option.label}を増やす`}
                  onClick={() => stepCounter(option, 1)}
                  disabled={(selections[option.id] as number) >= option.max}
                  className="h-8 w-8 rounded-full border border-neutral-300 text-lg leading-none disabled:opacity-30"
                >
                  ＋
                </button>
              </div>
            ) : null}
          </div>
        ))}

        <div className="mb-5">
          <p className="mb-1.5 text-sm font-medium text-neutral-700">数量</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="数量を減らす"
              onClick={() => setQuantity((current) => Math.max(1, current - 1))}
              disabled={quantity <= 1}
              className="h-8 w-8 rounded-full border border-neutral-300 text-lg leading-none disabled:opacity-30"
            >
              −
            </button>
            <span data-testid="quantity-count" className="w-6 text-center tabular-nums">
              {quantity}
            </span>
            <button
              type="button"
              aria-label="数量を増やす"
              onClick={() => setQuantity((current) => current + 1)}
              className="h-8 w-8 rounded-full border border-neutral-300 text-lg leading-none"
            >
              ＋
            </button>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg border border-neutral-300 py-2.5 font-medium text-neutral-700"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => onConfirm({ optionSelections: selections, quantity })}
            className="flex-[2] rounded-lg bg-neutral-900 py-2.5 font-medium text-white"
          >
            選択を確定
          </button>
        </div>
      </div>
    </div>
  );
}

import React from "react";

const ProblemSelector = ({ selectedVariant, onVariantChange }) => {
  const variants = [
    { id: "no-power", label: "No power", icon: "💡", desc: "Complete outage" },
    { id: "voltage-fluctuation", label: "Voltage fluctuation", icon: "〰️", desc: "Dim / flicker" },
    { id: "transformer-fault", label: "Transformer fault", icon: "⚡", desc: "Sparking / smoke" },
    { id: "broken-wire", label: "Broken wire", icon: "🔌", desc: "Hanging / snapped" },
    { id: "streetlight", label: "Streetlight", icon: "🏮", desc: "Not working" },
    { id: "meter-fault", label: "Meter fault", icon: "📊", desc: "Reading error" },
    { id: "billing", label: "Billing", icon: "🧾", desc: "Bill issue" },
    { id: "other", label: "Other", icon: "📝", desc: "Describe" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3">
      {variants.map((variant) => {
        const isSelected = selectedVariant === variant.id;
        return (
          <button
            key={variant.id}
            onClick={() => onVariantChange(variant.id)}
            className={`flex flex-col items-center text-center rounded-[14px] px-3 py-4 border-2 transition-all
              ${isSelected
                ? "bg-[#F2A93B]/[0.08] border-[#F2A93B] shadow-[0_0_0_1px_rgba(242,169,59,0.25),0_4px_16px_rgba(242,169,59,0.18)]"
                : "bg-white border-[#C9CFDB] hover:border-[#F2A93B]/40 hover:shadow-[0_2px_8px_rgba(10,27,51,0.06)]"
              }
            `}
          >
            <span className={`w-10 h-10 rounded-full flex items-center justify-center text-lg ${isSelected ? "bg-[#F2A93B] text-[#0A1B33]" : "bg-[#F7F5F0] text-[#0A1B33]"}`}>
              {variant.icon}
            </span>
            <span className={`mt-2 text-xs font-medium font-body ${isSelected ? "text-[#0A1B33]" : "text-[#0A1B33]"}`}>
              {variant.label}
            </span>
            <span className="text-[10px] text-[#5A6B8C]">{variant.desc}</span>
          </button>
        );
      })}
    </div>
  );
};

export default ProblemSelector;

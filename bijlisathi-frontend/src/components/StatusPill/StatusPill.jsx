import React from "react";

const StatusPill = ({ status, isUrgent }) => {
  const getConfig = () => {
    if (isUrgent) {
      return {
        label: "Urgent",
        wrapper: "bg-[#FF6B35]/[0.12] text-[#FF6B35] border border-[#FF6B35]/20",
        dot: "bg-[#FF6B35]",
      };
    }
    switch (status) {
      case "registered":
        return {
          label: "Registered",
          wrapper: "bg-[#5A6B8C]/[0.12] text-[#0A1B33] border border-[#C9CFDB]",
          dot: "bg-[#5A6B8C]",
        };
      case "working":
        return {
          label: "Working",
          wrapper: "bg-[#F2A93B]/[0.12] text-[#8a5a00] border border-[#F2A93B]/30",
          dot: "bg-[#F2A93B] animate-pulse",
        };
      case "resolved":
        return {
          label: "Resolved",
          wrapper: "bg-[#2E9E6B]/[0.12] text-[#2E9E6B] border border-[#2E9E6B]/20",
          dot: "bg-[#2E9E6B]",
        };
      default:
        return {
          label: status,
          wrapper: "bg-[#5A6B8C]/[0.12] text-[#0A1B33]",
          dot: "bg-[#5A6B8C]",
        };
    }
  };

  const cfg = getConfig();

  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium font-body ${cfg.wrapper}`}
    >
      <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
      <span className="ml-1.5 capitalize">{cfg.label}</span>
    </span>
  );
};

export default StatusPill;

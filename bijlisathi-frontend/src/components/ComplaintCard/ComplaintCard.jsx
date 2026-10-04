import React from "react";
import StatusPill from "../StatusPill/StatusPill";

const ComplaintCard = ({
  id,
  problemVariant,
  description,
  photoUrl,
  status,
  urgency,
  onAccept,
  isTechnician = false,
}) => {
  const variantLabels = {
    "no-power": "No power",
    "voltage-fluctuation": "Voltage fluctuation",
    "transformer-fault": "Transformer fault",
    "broken-wire": "Broken wire",
    "streetlight": "Streetlight",
    "meter-fault": "Meter fault",
    billing: "Billing",
    other: "Other",
  };

  return (
    <div className="rounded-[14px] bg-white border border-[#C9CFDB] p-4 shadow-[0_2px_8px_rgba(10,27,51,0.06)] hover:shadow-[0_8px_24px_rgba(10,27,51,0.12)] transition-shadow">
      {photoUrl ? (
        <img src={photoUrl} alt={problemVariant} className="w-full h-36 object-cover rounded-[8px] mb-3 border border-[#C9CFDB]" />
      ) : (
        <div className="w-full h-28 rounded-[8px] mb-3 border border-dashed border-[#C9CFDB] bg-[#F7F5F0] flex items-center justify-center">
          <span className="text-xs text-[#5A6B8C]">No photo — fault image will appear here</span>
        </div>
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <h3 className="text-sm font-medium text-[#0A1B33] capitalize font-display">
            {variantLabels[problemVariant] || problemVariant}
          </h3>
          <p className="text-sm text-[#5A6B8C] line-clamp-2 mt-1 font-body leading-5">{description}</p>
          <p className="text-xs text-[#5A6B8C] mt-1 font-mono">ID: {id} • 26.4499°N, 80.3319°E</p>
        </div>
        <StatusPill status={status} isUrgent={urgency} />
      </div>
      <div className="flex items-center gap-2 mt-4">
        {urgency && (
          <span className="px-2 py-1 text-xs font-medium bg-[#FF6B35]/[0.12] text-[#FF6B35] rounded-full border border-[#FF6B35]/20">
            ● Urgent
          </span>
        )}
        <div className="flex-1" />
        {!isTechnician ? (
          <button
            onClick={onAccept}
            className="px-5 py-2 bg-[#F2A93B] text-[#0A1B33] font-medium rounded-[8px] hover:shadow-[0_0_0_1px_rgba(242,169,59,0.25),0_4px_16px_rgba(242,169,59,0.18)] hover:scale-[0.98] active:scale-[0.97] transition-all text-sm"
          >
            View Details
          </button>
        ) : (
          <button
            onClick={onAccept}
            className="w-full py-3.5 bg-[#F2A93B] text-[#0A1B33] font-medium rounded-[8px] hover:shadow-[0_0_0_1px_rgba(242,169,59,0.25),0_4px_16px_rgba(242,169,59,0.18)] active:scale-[0.98] transition-all text-[1.05rem] min-h-[56px]"
          >
            Accept Task
          </button>
        )}
      </div>
    </div>
  );
};

export default ComplaintCard;

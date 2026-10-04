import React from "react";

const ComplaintTracker = ({ stages = ["registered", "working", "resolved"], currentStage = "registered" }) => {
  const order = ["registered", "working", "resolved"];
  const currentIndex = order.indexOf(currentStage);

  return (
    <div className="w-full">
      <div className="relative flex items-center justify-between">
        {/* wire background */}
        <div className="absolute top-[14px] left-[14px] right-[14px] h-[2px] bg-[#C9CFDB]" />
        {/* progress wire */}
        <div
          className="absolute top-[14px] left-[14px] h-[2px] bg-[#F2A93B] transition-all duration-500"
          style={{ width: currentIndex === 0 ? "0%" : currentIndex === 1 ? "50%" : "calc(100% - 28px)" }}
        />
        {/* pulsing dot for active stage - only if not resolved */}
        {currentStage === "working" && (
          <div
            className="absolute top-[14px] h-[2px] w-8 bg-gradient-to-r from-transparent via-white to-transparent opacity-60 animate-pulse"
            style={{ left: "50%", animationDuration: "2s" }}
          />
        )}

        {order.map((stage, index) => {
          const isCompleted = index < currentIndex;
          const isCurrent = index === currentIndex;
          const isPending = index > currentIndex;
          const isResolved = currentStage === "resolved" && stage === "resolved";

          return (
            <div key={stage} className="relative flex flex-col items-center z-10">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center border-2 transition-all duration-300
                ${isResolved ? "bg-[#2E9E6B] border-[#2E9E6B] text-white" : ""}
                ${isCompleted ? "bg-[#F2A93B] border-[#F2A93B] text-[#0A1B33]" : ""}
                ${isCurrent && !isResolved ? "bg-[#F2A93B] border-[#F2A93B] text-[#0A1B33] shadow-[0_0_0_4px_rgba(242,169,59,0.2)]" : ""}
                ${isPending ? "bg-white border-[#C9CFDB] text-[#5A6B8C]" : ""}
                ${isCurrent && stage === "working" ? "animate-pulse" : ""}
                `}
              >
                {isCompleted || isResolved ? (
                  <span className="text-xs">✓</span>
                ) : isCurrent ? (
                  <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                ) : (
                  <span className="w-2 h-2 rounded-full bg-[#C9CFDB]" />
                )}
              </div>
              <span
                className={`mt-2 text-xs font-medium capitalize font-body
                ${isCurrent ? "text-[#0A1B33]" : isCompleted || isResolved ? "text-[#0A1B33]" : "text-[#5A6B8C]"}
              `}
              >
                {stage}
              </span>
            </div>
          );
        })}
      </div>

      {/* labels below dashed vs solid logic from design.md */}
      <div className="mt-1 flex justify-between px-1">
        <span className="text-[10px] text-[#5A6B8C]">✓ solid amber wire</span>
        <span className="text-[10px] text-[#5A6B8C] text-center">~ pulsing amber node</span>
        <span className="text-[10px] text-[#5A6B8C]">○ dashed slate</span>
      </div>

      {currentStage === "resolved" && (
        <div className="mt-4 p-3 rounded-md bg-[#2E9E6B]/[0.08] border border-[#2E9E6B]/20 text-center">
          <span className="text-sm text-[#2E9E6B] font-medium">⚡ Power restored — current arriving home</span>
        </div>
      )}
    </div>
  );
};

export default ComplaintTracker;

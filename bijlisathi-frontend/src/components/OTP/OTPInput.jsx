import React, { useRef, useState } from "react";

const OTPInput = ({ onVerify }) => {
  const [values, setValues] = useState(Array(6).fill(""));
  const [verifiedFlash, setVerifiedFlash] = useState(false);
  const inputsRef = useRef([]);

  const handleChange = (index, val) => {
    if (!/^[0-9]?$/.test(val)) return;
    const next = [...values];
    next[index] = val;
    setValues(next);
    if (val && index < 5) inputsRef.current[index + 1]?.focus();
    const code = next.join("");
    if (code.length === 6 && !code.includes("")) {
      setVerifiedFlash(true);
      setTimeout(() => setVerifiedFlash(false), 600);
      onVerify?.(code);
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === "Backspace" && !values[index] && index > 0) {
      inputsRef.current[index - 1]?.focus();
    }
    if (e.key === "Paste" || (e.ctrlKey && e.key === "v")) {
      // handled by onPaste
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!pasted) return;
    const next = Array(6).fill("");
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i];
    setValues(next);
    if (pasted.length === 6) {
      setVerifiedFlash(true);
      setTimeout(() => setVerifiedFlash(false), 600);
      onVerify?.(pasted);
    }
    const focusIdx = Math.min(pasted.length, 5);
    inputsRef.current[focusIdx]?.focus();
  };

  return (
    <div className="flex gap-2" onPaste={handlePaste}>
      {values.map((v, i) => (
        <input
          key={i}
          ref={(el) => (inputsRef.current[i] = el)}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={v}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          className={`w-10 h-12 sm:w-12 sm:h-12 text-center text-lg font-mono font-medium rounded-[8px] border bg-white focus:outline-none transition-all
            ${verifiedFlash ? "border-[#2E9E6B] bg-[#2E9E6B]/[0.08] text-[#2E9E6B]" : "border-[#C9CFDB] focus:border-[#F2A93B] focus:shadow-[0_0_0_1px_rgba(242,169,59,0.25),0_4px_16px_rgba(242,169,59,0.18)] text-[#0A1B33]"}
          `}
          style={verifiedFlash ? { transitionDelay: `${i * 40}ms` } : {}}
        />
      ))}
    </div>
  );
};

export default OTPInput;

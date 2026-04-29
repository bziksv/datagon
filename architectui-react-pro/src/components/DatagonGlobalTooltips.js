import React, { useEffect, useMemo, useRef, useState } from "react";
import { Tooltip } from "reactstrap";

const SHOW_DELAY_MS = 80;

const getHintText = (button) => {
  const explicit = String(button.getAttribute("data-dg-tooltip") || "").trim();
  if (explicit) return explicit;
  const title = String(button.getAttribute("title") || "").trim();
  if (title) return title;
  const aria = String(button.getAttribute("aria-label") || "").trim();
  if (aria) return aria;
  return String(button.textContent || "").replace(/\s+/g, " ").trim();
};

const DatagonGlobalTooltips = ({ enabled = true }) => {
  const [targetEl, setTargetEl] = useState(null);
  const [tooltipText, setTooltipText] = useState("");
  const [open, setOpen] = useState(false);
  const showTimerRef = useRef(null);

  useEffect(() => {
    if (!enabled) return undefined;

    const clearTimer = () => {
      if (showTimerRef.current) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    };

    const close = () => {
      clearTimer();
      setOpen(false);
      setTargetEl(null);
      setTooltipText("");
    };

    const onMouseOver = (event) => {
      const button = event.target?.closest?.(".datagon-shell button");
      if (!(button instanceof HTMLButtonElement)) return;
      if (button.disabled) return;
      const hint = getHintText(button);
      if (!hint) return;

      clearTimer();
      showTimerRef.current = window.setTimeout(() => {
        setTooltipText(hint);
        setTargetEl(button);
        setOpen(true);
      }, SHOW_DELAY_MS);
    };

    const onMouseOut = (event) => {
      const fromButton = event.target?.closest?.(".datagon-shell button");
      if (!fromButton) return;
      const nextNode = event.relatedTarget;
      if (nextNode instanceof Node && fromButton.contains(nextNode)) return;
      close();
    };

    const onClick = () => close();
    const onKeyDown = (event) => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      clearTimer();
      document.removeEventListener("mouseover", onMouseOver, true);
      document.removeEventListener("mouseout", onMouseOut, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [enabled]);

  const hasTarget = useMemo(() => Boolean(enabled && open && targetEl && tooltipText), [enabled, open, targetEl, tooltipText]);
  if (!hasTarget) return null;

  return (
    <Tooltip
      isOpen={hasTarget}
      target={() => targetEl}
      placement="top"
      autohide
      fade
      delay={{ show: 0, hide: 0 }}
    >
      {tooltipText}
    </Tooltip>
  );
};

export default DatagonGlobalTooltips;

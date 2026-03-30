export default function DropLogo({ size = 64 }) {
  const w = size;
  const h = size;

  const dots = [
    { id: 1, cx: 13, cy: 30, color: "#64b5f6", dx:  10, dy: -28, delay: "0s",    dur: "3.6s" },
    { id: 2, cx: 13, cy: 46, color: "#ba68c8", dx:  -8, dy: -34, delay: "0.1s",  dur: "3.6s" },
    { id: 3, cx: 13, cy: 62, color: "#4db6ac", dx:  16, dy: -30, delay: "0.05s", dur: "3.6s" },
    { id: 4, cx: 36, cy: 30, color: "#64b5f6", dx: -18, dy: -38, delay: "0.15s", dur: "3.6s" },
    { id: 5, cx: 36, cy: 46, color: "#ba68c8", dx:   8, dy: -32, delay: "0.08s", dur: "3.6s" },
    { id: 6, cx: 36, cy: 62, color: "#4db6ac", dx: -11, dy: -26, delay: "0.2s",  dur: "3.6s" },
  ];

  const lines = [
    { id: 1, x1: 43, y1: 30, x2: 66, y2: 30, color: "#64b5f6" },
    { id: 2, x1: 43, y1: 46, x2: 62, y2: 46, color: "#ba68c8" },
    { id: 3, x1: 43, y1: 62, x2: 56, y2: 62, color: "#4db6ac" },
  ];

  return (
    <svg
      width={w}
      height={h}
      viewBox="0 0 74 74"
      xmlns="http://www.w3.org/2000/svg"
      style={{ overflow: "visible", display: "block" }}
    >
      <defs>
        <style>{`
          .drople-dot {
            animation: dropOrganize 3.6s cubic-bezier(0.25, 0.46, 0.45, 0.94) infinite both;
          }
          .drople-line {
            animation: lineReveal 3.6s ease-out infinite both;
            transform-box: fill-box;
            transform-origin: left center;
          }
          @keyframes dropOrganize {
            0%   { transform: translate(var(--dx), var(--dy)); opacity: 0; }
            7%   { opacity: 1; }
            40%  { transform: translate(calc(var(--dx) * 0.12), 3px); }
            47%  { transform: translate(0px, -4px); }
            54%  { transform: translate(0px, 0px); opacity: 1; }
            83%  { transform: translate(0px, 0px); opacity: 1; }
            95%  { opacity: 0; }
            100% { transform: translate(var(--dx), var(--dy)); opacity: 0; }
          }
          @keyframes lineReveal {
            0%   { transform: scaleX(0); opacity: 0; }
            54%  { transform: scaleX(0); opacity: 0; }
            64%  { transform: scaleX(0.4); opacity: 0.65; }
            76%  { transform: scaleX(1); opacity: 0.65; }
            84%  { opacity: 0.65; }
            95%  { opacity: 0; }
            100% { transform: scaleX(0); opacity: 0; }
          }
        `}</style>
      </defs>

      {lines.map((l) => (
        <line
          key={l.id}
          className="drople-line"
          x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
          stroke={l.color}
          strokeWidth="2.5"
          strokeLinecap="round"
          style={{ animationDelay: "0s" }}
        />
      ))}

      {dots.map((d) => (
        <circle
          key={d.id}
          className="drople-dot"
          cx={d.cx} cy={d.cy} r="4"
          fill={d.color}
          style={{
            "--dx": `${d.dx}px`,
            "--dy": `${d.dy}px`,
            animationDelay: d.delay,
            filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.3))",
          }}
        />
      ))}
    </svg>
  );
}

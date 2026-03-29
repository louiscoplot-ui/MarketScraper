export default function DropLogo({ size = 64 }) {
  return (
    <svg
      width={size}
      height={size * 1.4}
      viewBox="0 0 100 140"
      xmlns="http://www.w3.org/2000/svg"
      style={{ overflow: "visible" }}
    >
      <defs>
        <radialGradient id="dropGrad" cx="38%" cy="32%" r="60%">
          <stop offset="0%" stopColor="#a8d8ff" stopOpacity="0.95" />
          <stop offset="40%" stopColor="#4aa8f0" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#1565c0" stopOpacity="0.85" />
        </radialGradient>
        <radialGradient id="rippleGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#4aa8f0" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#4aa8f0" stopOpacity="0" />
        </radialGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        <style>{`
          .drop-body {
            animation: dropFall 2.4s cubic-bezier(0.4, 0, 0.8, 1) infinite;
            transform-origin: 50px 50px;
          }
          .drop-highlight {
            animation: dropFall 2.4s cubic-bezier(0.4, 0, 0.8, 1) infinite;
            transform-origin: 50px 50px;
          }
          .ripple1 {
            animation: ripple 2.4s ease-out infinite;
            transform-origin: 50px 112px;
          }
          .ripple2 {
            animation: ripple 2.4s ease-out 0.18s infinite;
            transform-origin: 50px 112px;
          }
          .splash-left {
            animation: splashL 2.4s ease-out infinite;
            transform-origin: 38px 110px;
          }
          .splash-right {
            animation: splashR 2.4s ease-out infinite;
            transform-origin: 62px 110px;
          }

          @keyframes dropFall {
            0%   { transform: translateY(-18px); opacity: 0; }
            12%  { opacity: 1; }
            62%  { transform: translateY(0px); opacity: 1; }
            68%  { transform: translateY(4px) scaleX(1.18) scaleY(0.55); opacity: 0.9; }
            78%  { transform: translateY(4px) scaleX(0); opacity: 0; }
            100% { transform: translateY(-18px); opacity: 0; }
          }

          @keyframes ripple {
            0%   { transform: scale(0); opacity: 0.7; }
            15%  { opacity: 0; }
            62%  { transform: scale(0); opacity: 0; }
            68%  { transform: scale(0.05); opacity: 0.6; }
            100% { transform: scale(1); opacity: 0; }
          }

          @keyframes splashL {
            0%   { transform: translate(0,0) rotate(0deg); opacity: 0; }
            62%  { transform: translate(0,0) rotate(0deg); opacity: 0; }
            68%  { transform: translate(0,0) rotate(0deg); opacity: 0.9; }
            85%  { transform: translate(-9px, -14px) rotate(-25deg); opacity: 0.7; }
            100% { transform: translate(-11px, -3px) rotate(-35deg); opacity: 0; }
          }

          @keyframes splashR {
            0%   { transform: translate(0,0) rotate(0deg); opacity: 0; }
            62%  { transform: translate(0,0) rotate(0deg); opacity: 0; }
            68%  { transform: translate(0,0) rotate(0deg); opacity: 0.9; }
            85%  { transform: translate(9px, -14px) rotate(25deg); opacity: 0.7; }
            100% { transform: translate(11px, -3px) rotate(35deg); opacity: 0; }
          }
        `}</style>
      </defs>

      {/* Ripple rings */}
      <ellipse className="ripple1" cx="50" cy="112" rx="22" ry="6" fill="none" stroke="#4aa8f0" strokeWidth="1.5" />
      <ellipse className="ripple2" cx="50" cy="112" rx="22" ry="6" fill="none" stroke="#4aa8f0" strokeWidth="1" />

      {/* Splash droplets */}
      <ellipse className="splash-left"  cx="38" cy="110" rx="2.5" ry="4" fill="url(#dropGrad)" />
      <ellipse className="splash-right" cx="62" cy="110" rx="2.5" ry="4" fill="url(#dropGrad)" />

      {/* Main drop */}
      <g className="drop-body" filter="url(#glow)">
        <path
          d="M50 18 C50 18, 22 60, 22 82 C22 97 34.5 108 50 108 C65.5 108 78 97 78 82 C78 60 50 18 50 18 Z"
          fill="url(#dropGrad)"
        />
        {/* Inner highlight */}
        <ellipse cx="40" cy="62" rx="7" ry="12" fill="white" opacity="0.35" transform="rotate(-18 40 62)" />
        <circle cx="43" cy="55" r="3.5" fill="white" opacity="0.5" />
      </g>
    </svg>
  );
}

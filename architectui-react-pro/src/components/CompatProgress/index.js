import React from 'react';
import { Progress as ReactstrapProgress } from 'reactstrap';

// React 19 compatible Progress component that mimics react-sweet-progress API
export const Progress = ({ 
  type = "line", 
  percent = 0, 
  width = "100%", 
  height = 20,
  strokeWidth = 4,
  theme = {},
  status = "active",
  color,
  ...props 
}) => {
  // Handle circle type progress
  if (type === "circle") {
    // Parse width to get size
    let size = 80; // default size
    if (typeof width === 'string' && width.includes('%')) {
      size = 80; // Use default for percentage widths
    } else if (typeof width === 'number') {
      size = width;
    } else if (typeof width === 'string' && !width.includes('%')) {
      size = parseInt(width) || 80;
    }
    
    const radius = size / 2;
    const actualStrokeWidth = strokeWidth || 4;
    const normalizedRadius = radius - actualStrokeWidth * 2;
    const circumference = normalizedRadius * 2 * Math.PI;
    const strokeDasharray = `${circumference} ${circumference}`;
    const strokeDashoffset = circumference - (percent / 100) * circumference;
    
    // Determine color based on status, color prop, or theme
    let strokeColor = "#007bff"; // default blue
    
    if (color === "danger" || status === "error") {
      strokeColor = theme?.error?.color || "#dc3545";
    } else if (status === "success") {
      strokeColor = "#28a745";
    } else if (theme?.active?.color) {
      strokeColor = theme.active.color;
    } else if (theme?.error?.color && status === "error") {
      strokeColor = theme.error.color;
    }
    
    const trailColor = theme?.active?.trailColor || theme?.error?.trailColor || "#e9ecef";
    
    const containerStyle = {
      width: typeof width === 'string' && width.includes('%') ? width : `${size}px`,
      height: `${size}px`,
      display: 'inline-block',
      position: 'relative'
    };
    
    return (
      <div style={containerStyle}>
        <svg
          width={size}
          height={size}
          style={{ transform: 'rotate(-90deg)' }}
        >
          {/* Background circle */}
          <circle
            stroke={trailColor}
            fill="transparent"
            strokeWidth={actualStrokeWidth}
            r={normalizedRadius}
            cx={radius}
            cy={radius}
          />
          {/* Progress circle */}
          <circle
            stroke={strokeColor}
            fill="transparent"
            strokeWidth={actualStrokeWidth}
            strokeDasharray={strokeDasharray}
            style={{ 
              strokeDashoffset,
              transition: 'stroke-dashoffset 0.3s ease'
            }}
            strokeLinecap="round"
            r={normalizedRadius}
            cx={radius}
            cy={radius}
          />
        </svg>
        {/* Percentage text overlay */}
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          fontSize: `${Math.max(10, size * 0.15)}px`,
          fontWeight: 'bold',
          color: strokeColor,
          pointerEvents: 'none'
        }}>
          {percent}%
        </div>
      </div>
    );
  }
  
  // Handle line type progress (default)
  let progressColor = "primary";
  if (color === "danger" || status === "error") {
    progressColor = "danger";
  } else if (status === "success") {
    progressColor = "success";
  } else if (color) {
    progressColor = color;
  }
  
  return (
    <ReactstrapProgress
      value={percent}
      color={progressColor}
      style={{ 
        width, 
        height: typeof height === 'number' ? `${height}px` : height 
      }}
      {...props}
    />
  );
};

export default Progress; 
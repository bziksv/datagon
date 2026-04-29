import React from 'react';
import './timeline.css';

// React 19 compatible VerticalTimeline component
export const VerticalTimeline = ({ children, className, layout, animate, ...props }) => {
  return (
    <div className={`vertical-timeline ${className || ''}`} {...props}>
      {children}
    </div>
  );
};

// React 19 compatible VerticalTimelineElement component
export const VerticalTimelineElement = ({ 
  children, 
  className, 
  icon, 
  date,
  position,
  ...props 
}) => {
  return (
    <div className={`vertical-timeline-element ${className || ''}`} {...props}>
      {icon && (
        <div className="vertical-timeline-element-icon">
          {icon}
        </div>
      )}
      <div className="vertical-timeline-element-content">
        {children}
        {date && (
          <span className="vertical-timeline-element-date">{date}</span>
        )}
      </div>
    </div>
  );
}; 
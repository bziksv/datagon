import React from 'react';
import './CustomScrollbar.css';

const CustomScrollbar = ({ 
  children, 
  className = '', 
  style = {}, 
  onScroll,
  ...props 
}) => {
  return (
    <div 
      className={`custom-scrollbar ${className}`}
      style={style}
      onScroll={onScroll}
      {...props}
    >
      {children}
    </div>
  );
};

export default CustomScrollbar; 
import React from 'react';

// React 19 compatible hamburger components to replace react-burgers
// Uses existing CSS classes from hamburgers.scss

const HamburgerBase = ({ 
  isOpen, 
  onClick, 
  type = 'slider', 
  className = '', 
  // Extract props that shouldn't be passed to DOM
  lineHeight,
  lineSpacing, 
  width,
  color,
  active,
  ...domProps // Only pass valid DOM props
}) => {
  return (
    <button
      className={`hamburger hamburger--${type} ${isOpen || active ? 'is-active' : ''} ${className}`}
      type="button"
      onClick={onClick}
      {...domProps} // Only pass valid DOM props
    >
      <span className="hamburger-box">
        <span className="hamburger-inner"></span>
      </span>
    </button>
  );
};

// Specific hamburger types
export const Slider = (props) => <HamburgerBase type="slider" {...props} />;
export const Elastic = (props) => <HamburgerBase type="elastic" {...props} />;
export const Emphatic = (props) => <HamburgerBase type="emphatic" {...props} />;
export const Spin = (props) => <HamburgerBase type="spin" {...props} />;
export const Vortex = (props) => <HamburgerBase type="vortex" {...props} />;
export const VortexR = (props) => <HamburgerBase type="vortex-r" {...props} />;
export const Minus = (props) => <HamburgerBase type="minus" {...props} />;
export const ThreeDX = (props) => <HamburgerBase type="3dx" {...props} />;
export const ThreeDY = (props) => <HamburgerBase type="3dy" {...props} />;
export const ThreeDXR = (props) => <HamburgerBase type="3dx-r" {...props} />;
export const ThreeDYR = (props) => <HamburgerBase type="3dy-r" {...props} />;

export default HamburgerBase;

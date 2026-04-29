import React, { useRef } from 'react';
import { CSSTransition as OriginalCSSTransition, TransitionGroup as OriginalTransitionGroup } from 'react-transition-group';
import ReactDOM from 'react-dom';

// React 19 compatibility: Polyfill findDOMNode if it doesn't exist
if (!ReactDOM.findDOMNode) {
  ReactDOM.findDOMNode = (instance) => {
    // In React 19, we can't use findDOMNode, so we return null or the instance itself if it's a DOM node
    if (!instance) return null;
    if (instance.nodeType) return instance; // It's already a DOM node
    return null; // Can't find DOM node without findDOMNode
  };
}

// React 19 compatible CSSTransition wrapper that automatically uses nodeRef
const CSSTransition = ({ children, component, ...props }) => {
  const nodeRef = useRef(null);
  
  // Handle the component prop properly
  if (component) {
    // Create the wrapper component with proper ref forwarding
    const WrapperComponent = React.forwardRef(({ children, ...wrapperProps }, ref) => {
      const Component = component;
      return React.createElement(Component, { ref, ...wrapperProps }, children);
    });
    
    return (
      <OriginalCSSTransition nodeRef={nodeRef} {...props}>
        <WrapperComponent ref={nodeRef}>
          {children}
        </WrapperComponent>
      </OriginalCSSTransition>
    );
  }
  
  // If children is not a valid React element, wrap it in a div
  if (!React.isValidElement(children)) {
    return (
      <OriginalCSSTransition nodeRef={nodeRef} {...props}>
        <div ref={nodeRef}>
          {children}
        </div>
      </OriginalCSSTransition>
    );
  }
  
  // Standard case: clone the child element with ref
  return (
    <OriginalCSSTransition nodeRef={nodeRef} {...props}>
      {React.cloneElement(children, { ref: nodeRef })}
    </OriginalCSSTransition>
  );
};

// TransitionGroup is usually fine as-is, but we'll export it for consistency
const TransitionGroup = OriginalTransitionGroup;

export { CSSTransition, TransitionGroup }; 
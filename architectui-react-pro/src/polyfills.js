import 'react-app-polyfill/ie11';
import ReactDOM from 'react-dom';

// React 19 compatibility: Add findDOMNode polyfill for legacy components
if (!ReactDOM.findDOMNode) {
  ReactDOM.findDOMNode = (instance) => {
    // In React 19, findDOMNode is removed, so we provide a safe fallback
    if (!instance) return null;
    
    // If it's already a DOM node, return it
    if (instance && instance.nodeType) {
      return instance;
    }
    
    // For React components, try to find their DOM node
    if (instance && typeof instance === 'object') {
      // Check if instance has a ref to a DOM node
      if (instance.current && instance.current.nodeType) {
        return instance.current;
      }
      
      // For class components, try accessing the underlying DOM node
      if (instance._reactInternalFiber || instance._reactInternals) {
        // This is a React component instance, but we can't safely access DOM in React 19
        console.warn('findDOMNode is deprecated and not fully supported in React 19. Consider using refs instead.');
        return null;
      }
    }
    
    return null;
  };
  
}

// Very minimal React 19 compatibility - only handle specific warnings
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.warn = function(...args) {
  const message = args[0];
  
  if (typeof message === 'string') {
    // Only suppress specific React 19 ref warnings
    if (message.includes('Accessing element.ref was removed in React 19') ||
        message.includes('ref is now a regular prop') ||
        message.includes('ref was removed in React 19') ||
        message.includes('findDOMNode is deprecated')) {
      return;
    }
  }
  
  originalConsoleWarn.apply(console, args);
};

console.error = function(...args) {
  const message = args[0];
  
  if (typeof message === 'string') {
    // Only suppress specific React 19 ref warnings that don't indicate real errors
    if (message.includes('Accessing element.ref was removed in React 19') ||
        message.includes('ref is now a regular prop') ||
        message.includes('ref was removed in React 19') ||
        message.includes('findDOMNode is deprecated')) {
      return;
    }
  }
  
  originalConsoleError.apply(console, args);
};

// ResizeObserver polyfill only if missing
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observedElements = new Set();
    }
    
    observe(element) {
      if (this.observedElements.has(element)) return;
      this.observedElements.add(element);
      
      const handleResize = () => {
        if (this.callback) {
          this.callback([{
            target: element,
            contentRect: element.getBoundingClientRect()
          }]);
        }
      };
      
      element._resizeHandler = handleResize;
      window.addEventListener('resize', handleResize);
      setTimeout(handleResize, 0);
    }
    
    unobserve(element) {
      if (element._resizeHandler) {
        window.removeEventListener('resize', element._resizeHandler);
        delete element._resizeHandler;
      }
      this.observedElements.delete(element);
    }
    
    disconnect() {
      this.observedElements.forEach(element => this.unobserve(element));
      this.observedElements.clear();
    }
  };
}


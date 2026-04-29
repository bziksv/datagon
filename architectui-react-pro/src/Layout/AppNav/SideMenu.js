import React, { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

const SideMenu = ({ content, onSelected, className = '' }) => {
  const location = useLocation();
  const [expandedItems, setExpandedItems] = useState({});

  // Enhanced active path detection for React Router v7
  const isActivePath = (path) => {
    if (!path) return false;
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };

  // Auto-expand menu item that contains current route
  useEffect(() => {
    const findAndExpandCurrentPath = (items, level = 0) => {
      items.forEach((item, index) => {
        const itemKey = `${level}-${index}-${item.label}`;
        
        if (item.content && Array.isArray(item.content)) {
          // Check if any child item matches current location
          const hasActiveChild = item.content.some(child => 
            child.to && isActivePath(child.to)
          );
          
          if (hasActiveChild) {
            setExpandedItems(prev => ({
              ...prev,
              [itemKey]: true
            }));
          }
          
          // Recursively check deeper levels
          findAndExpandCurrentPath(item.content, level + 1);
        }
      });
    };

    if (content && Array.isArray(content)) {
      findAndExpandCurrentPath(content);
    }
  }, [location.pathname, content]);

  // Toggle expansion of menu items
  const toggleExpanded = (itemKey) => {
    setExpandedItems(prev => ({
      ...prev,
      [itemKey]: !prev[itemKey]
    }));
  };

  // Check if menu item has active child
  const hasActiveChild = (items) => {
    if (!items || !Array.isArray(items)) return false;
    return items.some(item => {
      if (item.to && isActivePath(item.to)) return true;
      if (item.content) return hasActiveChild(item.content);
      return false;
    });
  };

  // Render menu items with full functionality
  const renderMenuItems = (items, level = 0) => {
    if (!items || !Array.isArray(items)) {
      return null;
    }

    return items.map((item, index) => {
      const itemKey = `${level}-${index}-${item.label}`;
      const hasSubMenu = item.content && Array.isArray(item.content) && item.content.length > 0;
      const isExpanded = expandedItems[itemKey];
      const hasActiveChildItem = hasActiveChild(item.content);
      
      if (hasSubMenu) {
        return (
          <li key={itemKey} className="metismenu-item">
            <a 
              href="#" 
              className={`metismenu-link ${hasActiveChildItem ? 'has-active-child' : ''}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleExpanded(itemKey);
              }}
              style={{ 
                cursor: 'pointer',
                pointerEvents: 'auto',
                zIndex: 1000
              }}
            >
              {item.icon && <i className={`metismenu-icon ${item.icon}`} />}
              {item.label}
              <i className={`metismenu-state-icon pe-7s-angle-down ${isExpanded ? 'rotate-minus-90' : ''}`} />
            </a>
            <ul className={`metismenu-container ${isExpanded ? 'visible' : ''}`}>
              {renderMenuItems(item.content, level + 1)}
            </ul>
          </li>
        );
      } else {
        // Leaf node - create a NavLink with enhanced active detection
        const isActive = isActivePath(item.to);
        return (
          <li key={itemKey} className="metismenu-item">
            <NavLink 
              to={item.to || '#'}
              className={`metismenu-link ${isActive ? 'active' : ''}`}
              onClick={(e) => {
                if (onSelected && typeof onSelected === 'function') {
                  onSelected(item);
                }
              }}
              style={{ 
                cursor: 'pointer',
                pointerEvents: 'auto',
                zIndex: 1000
              }}
            >
              {item.icon && <i className={`metismenu-icon ${item.icon}`} />}
              {item.label}
            </NavLink>
          </li>
        );
      }
    });
  };

  return (
    <div 
      className={`vertical-nav-menu ${className}`.trim()}
      style={{ 
        pointerEvents: 'auto', 
        zIndex: 999,
        position: 'relative'
      }}
    >
      <ul className="metismenu-container">
        {renderMenuItems(content)}
      </ul>
    </div>
  );
};

export default SideMenu;

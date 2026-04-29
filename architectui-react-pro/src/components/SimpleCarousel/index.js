import React, { useState, useEffect } from 'react';
import './SimpleCarousel.css';

const SimpleCarousel = ({ items = [], interval = 5000, controls = true, indicators = true }) => {
  const [activeIndex, setActiveIndex] = useState(0);

  // Auto-advance slides
  useEffect(() => {
    if (!interval) return;
    
    const timer = setInterval(() => {
      setActiveIndex((prevIndex) => 
        prevIndex === items.length - 1 ? 0 : prevIndex + 1
      );
    }, interval);

    return () => clearInterval(timer);
  }, [interval, items.length]);

  const goToSlide = (index) => {
    setActiveIndex(index);
  };

  const nextSlide = () => {
    setActiveIndex(activeIndex === items.length - 1 ? 0 : activeIndex + 1);
  };

  const prevSlide = () => {
    setActiveIndex(activeIndex === 0 ? items.length - 1 : activeIndex - 1);
  };

  if (!items || items.length === 0) {
    return <div className="simple-carousel">No items to display</div>;
  }

  return (
    <div className="simple-carousel">
      <div className="carousel-inner">
        {items.map((item, index) => (
          <div
            key={item.key || index}
            className={`carousel-item ${index === activeIndex ? 'active' : ''}`}
          >
            {item.src ? (
              <img
                src={item.src}
                alt={item.altText || `Slide ${index + 1}`}
                className="carousel-image"
              />
            ) : (
              <div className="carousel-placeholder">
                <h3>{item.caption || `Slide ${index + 1}`}</h3>
              </div>
            )}
            {(item.caption || item.header) && (
              <div className="carousel-caption">
                {item.header && <h5>{item.header}</h5>}
                {item.caption && <p>{item.caption}</p>}
              </div>
            )}
          </div>
        ))}
      </div>

      {controls && items.length > 1 && (
        <>
          <button
            className="carousel-control prev"
            onClick={prevSlide}
            type="button"
          >
            <span className="carousel-control-icon">‹</span>
            <span className="sr-only">Previous</span>
          </button>
          <button
            className="carousel-control next"
            onClick={nextSlide}
            type="button"
          >
            <span className="carousel-control-icon">›</span>
            <span className="sr-only">Next</span>
          </button>
        </>
      )}

      {indicators && items.length > 1 && (
        <ol className="carousel-indicators">
          {items.map((_, index) => (
            <li
              key={index}
              className={index === activeIndex ? 'active' : ''}
              onClick={() => goToSlide(index)}
            />
          ))}
        </ol>
      )}
    </div>
  );
};

export default SimpleCarousel; 
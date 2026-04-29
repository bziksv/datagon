import React, { Fragment, useState, useEffect, useRef } from "react";

import cx from "classnames";

import { ListGroup, ListGroupItem } from "reactstrap";

import CustomScrollbar from "../../../../components/CustomScrollbar";

const lists = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
];

const VisibilityListItem = ({ list, containment }) => {
  const [isVisible, setIsVisible] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current || !containment) return;

    const checkVisibility = () => {
      if (ref.current && containment) {
        const rect = ref.current.getBoundingClientRect();
        const containerRect = containment.getBoundingClientRect();
        
        const visible = rect.top < containerRect.bottom && 
                       rect.bottom > containerRect.top &&
                       rect.left < containerRect.right && 
                       rect.right > containerRect.left;
        
        setIsVisible(visible);
      }
    };

    checkVisibility();
    
    // Check on scroll
    containment.addEventListener('scroll', checkVisibility);
    window.addEventListener('resize', checkVisibility);

    return () => {
      containment.removeEventListener('scroll', checkVisibility);
      window.removeEventListener('resize', checkVisibility);
    };
  }, [containment]);

  return (
    <ListGroupItem
      ref={ref}
      className={cx("animated", {
        fadeIn: isVisible,
        fadeOut: !isVisible,
      })}
      style={{
        background: isVisible ? "transparent" : "#f65ca2",
      }}>
      I am #{list}
    </ListGroupItem>
  );
};

export default function FadeVisibility() {
  const [getElement, setGetElement] = useState(null);

  useEffect(() => {
    setGetElement(document.getElementById("sample"));
  }, []);

  return (
    <Fragment>
      <div id="sample" className="scroll-area-md">
        <CustomScrollbar>
          <ListGroup flush>
            {lists.map((list) => (
              <VisibilityListItem
                key={list}
                list={list}
                containment={getElement}
              />
            ))}
          </ListGroup>
        </CustomScrollbar>
      </div>
    </Fragment>
  );
}

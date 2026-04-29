import React, { Component } from "react";
import SimpleCarousel from "../../../../../components/SimpleCarousel";

import image1 from "../../../../../assets/utils/images/dropdown-header/abstract1.jpg";
import image2 from "../../../../../assets/utils/images/dropdown-header/abstract2.jpg";
import image3 from "../../../../../assets/utils/images/dropdown-header/abstract3.jpg";

const items = [
  {
    src: image1,
    altText: "Slide 1",
    caption: "Slide 1",
    header: "Slide 1",
    key: 1
  },
  {
    src: image2,
    altText: "Slide 2",
    caption: "Slide 2", 
    header: "Slide 2",
    key: 2
  },
  {
    src: image3,
    altText: "Slide 3",
    caption: "Slide 3",
    header: "Slide 3",
    key: 3
  },
];

class CustomExample extends Component {
  render() {
    return (
      <div>
        <SimpleCarousel items={items} />
      </div>
    );
  }
}

export default CustomExample;

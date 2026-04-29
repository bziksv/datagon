import React from "react";
import { InputGroup, Input, InputGroupText } from "reactstrap";

const FormInputGroupSizing = (props) => {
  return (
    <div>
      <InputGroup bsSize="lg">
        <InputGroupText addonType="prepend">@lg</InputGroupText>
        <Input />
      </InputGroup>
      <br />
      <InputGroup>
        <InputGroupText addonType="prepend">@normal</InputGroupText>
        <Input />
      </InputGroup>
      <br />
      <InputGroup bsSize="sm">
        <InputGroupText addonType="prepend">@sm</InputGroupText>
        <Input />
      </InputGroup>
    </div>
  );
};

export default FormInputGroupSizing;

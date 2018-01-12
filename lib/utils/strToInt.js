"use strict";

const murmur = require("murmurhash").v3;
const isUUID = require("./isUUID.js");

const strToInt = _str => {

    if(_str === null || _str === "undefined"){
        throw new Error("str to int field is null or undefined.");
    }

    //speed up on body values for example
    if(typeof _str === "number"){
        return _str;
    }

    //for req params for example
    let str = parseInt(_str);
    if(!isNaN(str) && !isUUID(_str)){
        return str;
    }

    //its a string, we need to hash
    return murmur(_str);
};

module.exports = strToInt;
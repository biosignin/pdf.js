/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals PDFJS, Util, isDict, isName, stringToPDFString, warn, Dict, Stream,
           stringToBytes, assert, Promise, isArray, ObjectLoader, OperatorList,
           isValidUrl, OPS, createPromiseCapability, AnnotationType */

'use strict';

var DEFAULT_ICON_SIZE = 22; // px
var SUPPORTED_TYPES = ['Link', 'Text', 'Widget'];

var Annotation = (function AnnotationClosure() {
  // 12.5.5: Algorithm: Appearance streams
  function getTransformMatrix(rect, bbox, matrix) {
    var bounds = Util.getAxialAlignedBoundingBox(bbox, matrix);
    var minX = bounds[0];
    var minY = bounds[1];
    var maxX = bounds[2];
    var maxY = bounds[3];

    if (minX === maxX || minY === maxY) {
      // From real-life file, bbox was [0, 0, 0, 0]. In this case,
      // just apply the transform for rect
      return [1, 0, 0, 1, rect[0], rect[1]];
    }

    var xRatio = (rect[2] - rect[0]) / (maxX - minX);
    var yRatio = (rect[3] - rect[1]) / (maxY - minY);
    return [
      xRatio,
      0,
      0,
      yRatio,
      rect[0] - minX * xRatio,
      rect[1] - minY * yRatio
    ];
  }

  function getDefaultAppearance(dict) {
    var appearanceState = dict.get('AP');
    if (!isDict(appearanceState)) {
      return;
    }

    var appearance;
    var appearances = appearanceState.get('N');
    if (isDict(appearances)) {
      var as = dict.get('AS');
      if (as && appearances.has(as.name)) {
        appearance = appearances.get(as.name);
      }
    } else {
      appearance = appearances;
    }
    return appearance;
  }

  function Annotation(params) {
    var dict = params.dict;
    var data = this.data = {};

    data.subtype = dict.get('Subtype').name;
    var rect = dict.get('Rect') || [0, 0, 0, 0];
    data.rect = Util.normalizeRect(rect);
    data.annotationFlags = dict.get('F');

    var color = dict.get('C');
    if (isArray(color) && color.length === 3) {
      // TODO(mack): currently only supporting rgb; need support different
      // colorspaces
      data.color = color;
    } else {
      data.color = [0, 0, 0];
    }

    // Some types of annotations have border style dict which has more
    // info than the border array
    if (dict.has('BS')) {
      var borderStyle = dict.get('BS');
      data.borderWidth = borderStyle.has('W') ? borderStyle.get('W') : 1;
    } else {
      var borderArray = dict.get('Border') || [0, 0, 1];
      data.borderWidth = borderArray[2] || 0;

      // TODO: implement proper support for annotations with line dash patterns.
      var dashArray = borderArray[3];
      if (data.borderWidth > 0 && dashArray) {
        if (!isArray(dashArray)) {
          // Ignore the border if dashArray is not actually an array,
          // this is consistent with the behaviour in Adobe Reader. 
          data.borderWidth = 0;
        } else {
          var dashArrayLength = dashArray.length;
          if (dashArrayLength > 0) {
            // According to the PDF specification: the elements in a dashArray
            // shall be numbers that are nonnegative and not all equal to zero.
            var isInvalid = false;
            var numPositive = 0;
            for (var i = 0; i < dashArrayLength; i++) {
              var validNumber = (+dashArray[i] >= 0);
              if (!validNumber) {
                isInvalid = true;
                break;
              } else if (dashArray[i] > 0) {
                numPositive++;
              }
            }
            if (isInvalid || numPositive === 0) {
              data.borderWidth = 0;
            }
          }
        }
      }
    }

    this.appearance = getDefaultAppearance(dict);
    data.hasAppearance = !!this.appearance;
    data.id = params.ref.num;
  }

  Annotation.prototype = {

    getData: function Annotation_getData() {
      return this.data;
    },

    isInvisible: function Annotation_isInvisible() {
      var data = this.data;
      if (data && SUPPORTED_TYPES.indexOf(data.subtype) !== -1) {
        return false;
      } else {
        return !!(data &&
                  data.annotationFlags &&            // Default: not invisible
                  data.annotationFlags & 0x1);       // Invisible
      }
    },

    isViewable: function Annotation_isViewable() {
      var data = this.data;
      return !!(!this.isInvisible() &&
                data &&
                (!data.annotationFlags ||
                 !(data.annotationFlags & 0x22)) &&  // Hidden or NoView
                data.rect);                          // rectangle is necessary
    },

    isPrintable: function Annotation_isPrintable() {
      var data = this.data;
      return !!(!this.isInvisible() &&
                data &&
                data.annotationFlags &&              // Default: not printable
                data.annotationFlags & 0x4 &&        // Print
                !(data.annotationFlags & 0x2) &&     // Hidden
                data.rect);                          // rectangle is necessary
    },

    loadResources: function Annotation_loadResources(keys) {
      return new Promise(function (resolve, reject) {
        this.appearance.dict.getAsync('Resources').then(function (resources) {
          if (!resources) {
            resolve();
            return;
          }
          var objectLoader = new ObjectLoader(resources.map,
                                              keys,
                                              resources.xref);
          objectLoader.load().then(function() {
            resolve(resources);
          }, reject);
        }, reject);
      }.bind(this));
    },

    getOperatorList: function Annotation_getOperatorList(evaluator) {

      if (!this.appearance) {
        return Promise.resolve(new OperatorList());
      }

      var data = this.data;

      var appearanceDict = this.appearance.dict;
      var resourcesPromise = this.loadResources([
        'ExtGState',
        'ColorSpace',
        'Pattern',
        'Shading',
        'XObject',
        'Font'
        // ProcSet
        // Properties
      ]);
      var bbox = appearanceDict.get('BBox') || [0, 0, 1, 1];
      var matrix = appearanceDict.get('Matrix') || [1, 0, 0, 1, 0 ,0];
      var transform = getTransformMatrix(data.rect, bbox, matrix);
      var self = this;

      return resourcesPromise.then(function(resources) {
          var opList = new OperatorList();
          opList.addOp(OPS.beginAnnotation, [data.rect, transform, matrix]);
          return evaluator.getOperatorList(self.appearance, resources, opList).
            then(function () {
              opList.addOp(OPS.endAnnotation, []);
              self.appearance.reset();
              return opList;
            });
        });
    }
  };

  Annotation.getConstructor =
      function Annotation_getConstructor(subtype, fieldType) {

    if (!subtype) {
      return;
    }

    // TODO(mack): Implement FreeText annotations
    if (subtype === 'Link') {
      return LinkAnnotation;
    } else if (subtype === 'Text') {
      return TextAnnotation;
    } else if (subtype === 'Widget') {
      if (!fieldType) {
        return;
      }

      if (fieldType === 'Tx') {
        return TextWidgetAnnotation;
      } else if (fieldType === 'Sig') {
        return SigWidgetAnnotation;
      }  else {
        return WidgetAnnotation;
      }
    } else {
      return Annotation;
    }
  };

  Annotation.fromRef = function Annotation_fromRef(xref, ref) {

    var dict = xref.fetchIfRef(ref);
    if (!isDict(dict)) {
      return;
    }

    var subtype = dict.get('Subtype');
    subtype = isName(subtype) ? subtype.name : '';
    if (!subtype) {
      return;
    }

    var fieldType = Util.getInheritableProperty(dict, 'FT');
    fieldType = isName(fieldType) ? fieldType.name : '';

    var Constructor = Annotation.getConstructor(subtype, fieldType);
    if (!Constructor) {
      return;
    }

    var params = {
      dict: dict,
      ref: ref,
    };

    var annotation = new Constructor(params);

    if (annotation.isViewable() || annotation.isPrintable()) {
      return annotation;
    } else {
      if (SUPPORTED_TYPES.indexOf(subtype) === -1) {
        warn('unimplemented annotation type: ' + subtype);
      }
    }
  };

  Annotation.appendToOperatorList = function Annotation_appendToOperatorList(
      annotations, opList, pdfManager, partialEvaluator, intent) {

    function reject(e) {
      annotationsReadyCapability.reject(e);
    }

    var annotationsReadyCapability = createPromiseCapability();

    var annotationPromises = [];
    for (var i = 0, n = annotations.length; i < n; ++i) {
      if (intent === 'display' && annotations[i].isViewable() ||
          intent === 'print' && annotations[i].isPrintable()) {
        annotationPromises.push(
          annotations[i].getOperatorList(partialEvaluator));
      }
    }
    Promise.all(annotationPromises).then(function(datas) {
      opList.addOp(OPS.beginAnnotations, []);
      for (var i = 0, n = datas.length; i < n; ++i) {
        var annotOpList = datas[i];
        opList.addOpList(annotOpList);
      }
      opList.addOp(OPS.endAnnotations, []);
      annotationsReadyCapability.resolve();
    }, reject);

    return annotationsReadyCapability.promise;
  };

  return Annotation;
})();

var WidgetAnnotation = (function WidgetAnnotationClosure() {

  function WidgetAnnotation(params) {
    Annotation.call(this, params);

    var dict = params.dict;
    var data = this.data;

    data.fieldValue = stringToPDFString(
      Util.getInheritableProperty(dict, 'V') || '');
    data.alternativeText = stringToPDFString(dict.get('TU') || '');
    data.defaultAppearance = Util.getInheritableProperty(dict, 'DA') || '';
    var fieldType = Util.getInheritableProperty(dict, 'FT');
    data.fieldType = isName(fieldType) ? fieldType.name : '';
    data.fieldFlags = Util.getInheritableProperty(dict, 'Ff') || 0;
    this.fieldResources = Util.getInheritableProperty(dict, 'DR') || Dict.empty;

    // Building the full field name by collecting the field and
    // its ancestors 'T' data and joining them using '.'.
    var fieldName = [];
    var namedItem = dict;
    var ref = params.ref;
    while (namedItem) {
      var parent = namedItem.get('Parent');
      var parentRef = namedItem.getRaw('Parent');
      var name = namedItem.get('T');
      if (name) {
        fieldName.unshift(stringToPDFString(name));
      } else {
        // The field name is absent, that means more than one field
        // with the same name may exist. Replacing the empty name
        // with the '`' plus index in the parent's 'Kids' array.
        // This is not in the PDF spec but necessary to id the
        // the input controls.
        var kids = parent.get('Kids');
        var j, jj;
        for (j = 0, jj = kids.length; j < jj; j++) {
          var kidRef = kids[j];
          if (kidRef.num === ref.num && kidRef.gen === ref.gen) {
            break;
          }
        }
        fieldName.unshift('`' + j);
      }
      namedItem = parent;
      ref = parentRef;
    }
    data.fullName = fieldName.join('.');
  }

  var parent = Annotation.prototype;
  Util.inherit(WidgetAnnotation, Annotation, {
    isViewable: function WidgetAnnotation_isViewable() {
      return parent.isViewable.call(this);
    }
  });

  return WidgetAnnotation;
})();

var SigWidgetAnnotation = (function SigWidgetAnnotationClosure() {
  function SigWidgetAnnotation(params) {
    WidgetAnnotation.call(this, params);

    var dict = params.dict;

    var data = this.data;

    data.fieldValue = Util.getInheritableProperty(params.dict, 'V');
    
    if(!data.fieldValue) return;

    var contentsValue = data.fieldValue.get('Contents');
    var byteRange = data.fieldValue.get('ByteRange'); 
    var subFilter = data.fieldValue.get("SubFilter");

   


    require(['forge.bundle'], function (forge) {
      function preparePKCS7(str) {
        var p7 = "-----BEGIN PKCS7-----\n";
        p7 +=str;
        p7 += "\n-----END PKCS7-----";
        return p7;
      }
      try{
      var isCades = subFilter.name == "ETSI.CAdES.detached";
      var isTsp   = subFilter.name == "ETSI.RFC3161";

       /* pkcs7 der encoded object */
      var pkcs7object = preparePKCS7(forge.util.encode64(contentsValue,64));

      var validCert = true;
      var validHash = true;
      var docModified = true;

      /* pkcs7 object */
      var p7 = forge.pkcs7.messageFromPem(pkcs7object);

      /* certificate chain */
      var certificateChain = p7.certificates;

      var signCert = certificateChain[0];
      var signSerialNumber = forge.util.bytesToHex(p7.rawCapture.signerInfos[0].value[1].value[1].value);
      var sequentialCertChain = [];
      /* find the signing cert */
      for (var index = 0; index < certificateChain.length; ++index) {
          if(certificateChain[index].serialNumber == signSerialNumber){
            signCert = certificateChain[index];
            sequentialCertChain.push(signCert);
            break;
          }
      }
      var lastFound = signCert;
      for (var index = 0; index < certificateChain.length; ++index) {
          if(lastFound != certificateChain[index] && lastFound.isIssuer(certificateChain[index])){
            lastFound = certificateChain[index];
            sequentialCertChain.push(lastFound);
            index = 0;
          }
      }
      
      /* verifies the signature in signerInfo */
      var digestAlgo = forge.oids[forge.asn1.derToOid(p7.rawCapture.signerInfos[0].value[2].value[0].value)];
      var attrSet = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, p7.rawCapture.authenticatedAttributes);
      var md = forge.md[digestAlgo].create();      
      md.update(forge.asn1.toDer(attrSet).bytes());
      var authdigest = md.digest().bytes();

      //var signed = "6bfd7226e101c2874630174ba846b92aa4d824d8bb5ff2b7404f776f0668e18b3d7c66945b7616505668b194639d4a75d09fa62299ad769964c0711c953b126526a5bbb0474d44aa373c09951ad60411cb3c576fb338314c5e697d6c9f366f1e50eedc3734894d5ca1372c79a4359a569ea146926275878381ba4e7e98957882";
      validHash = signCert.publicKey.verify(authdigest,p7.rawCapture.signature);
      
      if(validHash){
        //Verify that the MessageDigest (oid 1.2.840.113549.1.9.4) in authenticatedAttributes is equal to the 
        //digest of the document
        var attrlenght = p7.rawCapture.authenticatedAttributes.length;
        for(var index = 0 ; index<attrlenght ; index++){
          var authattr = p7.rawCapture.authenticatedAttributes[index];
          if(forge.asn1.derToOid(authattr.value[0].value) == forge.oids['messageDigest']){
             /* prepares file contents to be hashed, excluding the contents part according to the byterange */
            var fileContents = getContentForDigest(byteRange, dict.xref.stream.bytes);
            md = forge.md[digestAlgo].create();
            md.update(fileContents);
            var doc_hash = md.digest().bytes();
            
            docModified = !(authattr.value[1].value[0].value == doc_hash);
          }
          
        }
      }

 /* @param ed the encrypted data to decrypt in as a byte string.
 * @param key the RSA key to use.
 * @param pub true for a public key operation, false for private.
 * @param ml the message length, if known, false to disable padding.
 * @return the decrypted message as a byte string.
 */

      //compare decrypted with the hash value

      /* check if the hash value
          in the pkcs7 object matches the pdf's hash value
      var res = toHex(contentsValue).indexOf(hash_data);
      if(res == -1) { // hash value not found in the contentsValue
        validHash = false;
      }*/

      /* check the certificate chain */

      try {
        if(sequentialCertChain.length > 1){
          var caStore = forge.pki.createCaStore();
          caStore.addCertificate(sequentialCertChain[sequentialCertChain.length-1]);
          forge.pki.verifyCertificateChain(caStore, sequentialCertChain);
        }else{
           validCert = false;
           console.log("Cannot verify the signing certificate, chain missing");
        }
      } catch(err) {
        validCert = false;
        console.log(err.message);
      }

      if(validCert && validHash && !docModified) {
        /* valid digital signature */
        console.log("Valid signature!");
      }
      else {
        console.log("Invalid signature!\nReason:");
      }

      if(!validHash) { console.log("- invalid hash"); }
      if(!validCert) { console.log("- invalid cert"); }
      if(docModified) { console.log("- document modified after signature"); }

      this.visible = validHash && validCert && !docModified;

      console.log("Signed by  " + signCert.subject.getField("CN").value);
      console.log("\n\n");

    }catch(e){console.log(e);}
    });
      

  }

  var parent = WidgetAnnotation.prototype;
  Util.inherit(SigWidgetAnnotation, WidgetAnnotation, {
   isViewable: function WidgetAnnotation_isViewable() {
      return parent.isViewable.call(this);
    }
  });
  
  return SigWidgetAnnotation;
  
})();



function getContentForDigest(byteRange, pdfData) {

  var lim1 = byteRange[0];
      var lim2 = byteRange[1];
      var lim3 = byteRange[2];
      var lim4 = byteRange[3];

      var x = '';
      for(var i = lim1; i < (lim3+lim4); i++) {
        if(i < lim2 || i >= (lim3)) {
          x += String.fromCharCode(pdfData[i]);
        }
      }

      return x;
    }




var TextWidgetAnnotation = (function TextWidgetAnnotationClosure() {
  function TextWidgetAnnotation(params) {
    WidgetAnnotation.call(this, params);

    this.data.textAlignment = Util.getInheritableProperty(params.dict, 'Q');
    this.data.annotationType = AnnotationType.WIDGET;
    this.data.hasHtml = !this.data.hasAppearance && !!this.data.fieldValue;
  }

  Util.inherit(TextWidgetAnnotation, WidgetAnnotation, {
    getOperatorList: function TextWidgetAnnotation_getOperatorList(evaluator) {
      if (this.appearance) {
        return Annotation.prototype.getOperatorList.call(this, evaluator);
      }

      var opList = new OperatorList();
      var data = this.data;

      // Even if there is an appearance stream, ignore it. This is the
      // behaviour used by Adobe Reader.
      if (!data.defaultAppearance) {
        return Promise.resolve(opList);
      }

      var stream = new Stream(stringToBytes(data.defaultAppearance));
      return evaluator.getOperatorList(stream, this.fieldResources, opList).
        then(function () {
          return opList;
        });
    }
  });

  return TextWidgetAnnotation;
})();

var InteractiveAnnotation = (function InteractiveAnnotationClosure() {
  function InteractiveAnnotation(params) {
    Annotation.call(this, params);

    this.data.hasHtml = true;
  }

  Util.inherit(InteractiveAnnotation, Annotation, { });

  return InteractiveAnnotation;
})();

var TextAnnotation = (function TextAnnotationClosure() {
  function TextAnnotation(params) {
    InteractiveAnnotation.call(this, params);

    var dict = params.dict;
    var data = this.data;

    var content = dict.get('Contents');
    var title = dict.get('T');
    data.annotationType = AnnotationType.TEXT;
    data.content = stringToPDFString(content || '');
    data.title = stringToPDFString(title || '');

    if (data.hasAppearance) {
      data.name = 'NoIcon';
    } else {
      data.rect[1] = data.rect[3] - DEFAULT_ICON_SIZE;
      data.rect[2] = data.rect[0] + DEFAULT_ICON_SIZE;
      data.name = dict.has('Name') ? dict.get('Name').name : 'Note';
    }

    if (dict.has('C')) {
      data.hasBgColor = true;
    }
  }

  Util.inherit(TextAnnotation, InteractiveAnnotation, { });

  return TextAnnotation;
})();

var LinkAnnotation = (function LinkAnnotationClosure() {
  function LinkAnnotation(params) {
    InteractiveAnnotation.call(this, params);

    var dict = params.dict;
    var data = this.data;
    data.annotationType = AnnotationType.LINK;

    var action = dict.get('A');
    if (action) {
      var linkType = action.get('S').name;
      if (linkType === 'URI') {
        var url = action.get('URI');
        if (isName(url)) {
          // Some bad PDFs do not put parentheses around relative URLs.
          url = '/' + url.name;
        } else if (url) {
          url = addDefaultProtocolToUrl(url);
        }
        // TODO: pdf spec mentions urls can be relative to a Base
        // entry in the dictionary.
        if (!isValidUrl(url, false)) {
          url = '';
        }
        data.url = url;
      } else if (linkType === 'GoTo') {
        data.dest = action.get('D');
      } else if (linkType === 'GoToR') {
        var urlDict = action.get('F');
        if (isDict(urlDict)) {
          // We assume that the 'url' is a Filspec dictionary
          // and fetch the url without checking any further
          url = urlDict.get('F') || '';
        }

        // TODO: pdf reference says that GoToR
        // can also have 'NewWindow' attribute
        if (!isValidUrl(url, false)) {
          url = '';
        }
        data.url = url;
        data.dest = action.get('D');
      } else if (linkType === 'Named') {
        data.action = action.get('N').name;
      } else {
        warn('unrecognized link type: ' + linkType);
      }
    } else if (dict.has('Dest')) {
      // simple destination link
      var dest = dict.get('Dest');
      data.dest = isName(dest) ? dest.name : dest;
    }
  }

  // Lets URLs beginning with 'www.' default to using the 'http://' protocol.
  function addDefaultProtocolToUrl(url) {
    if (url && url.indexOf('www.') === 0) {
      return ('http://' + url);
    }
    return url;
  }

  Util.inherit(LinkAnnotation, InteractiveAnnotation, {
    hasOperatorList: function LinkAnnotation_hasOperatorList() {
      return false;
    }
  });

  return LinkAnnotation;
})();

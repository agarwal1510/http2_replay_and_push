//Conor Kelton
//http2_replay_server.js

//For each request, matches (either fully or closest match with fsm) the request to one of the record files as given by the record script
//For secure requests (https://) sends the response headers (optional) and the response body for this request over the wire in http2
//If pushing is enabled, before intialzing the server, reads in a file of objects to push, and pushes them when the main HTML is requested.
//For insecure requests (http://) sends the response headers (optional) and the response body for this request over the wire in http1.1

//For the node-http2 public API see: https://github.com/molnarg/node-http2/wiki/Public-API

//TODO: (in no particular order)
//		Better error handling of promises
//		Refactor globals for request/response matching
//		Better handling of doubly matched URLS (sometimes the html is matched to some dummy request, which requires running this multiple times to get desired results)
//		Potentially add a Promise.race() for finding a given record response when not using 'matching=true'
//		Integrate handling of CrossOrigin Pushes now that the '--trusted-spdy-proxy' flag is gone
//		Handling of requests at different ports other than the http(s) defaults.
//		FSM crashing for extremely large URLS. Consider thresholding on string size or using a different matcher
//		Handle 'gzipping' of objects written on the wire
//		Handle 'minification' of JS and CSS

//Libraries
var fs = require('fs');
var path = require('path');
var os = require('os');
var http = require('http');
var http2 = require('http2');
var fsm = require('fuzzy-string-matching');
const proc = require('process');

//Globals
var ssl_options = {key: fs.readFileSync('/path/to/key.key'), cert: fs.readFileSync('/path/to/certificate.cert')}; //SSL information
var push_urls_array = JSON.parse(fs.readFileSync("push_urls.json", 'utf-8')).push_urls; //Array of full URLS to push. node-http2 will parse off authority and path automatically
var link_header = JSON.parse(fs.readFileSync("push_urls.json", 'utf-8')).link_headers; //Array of LRP headers. Used by chrome to make pushes (i.e. PUSH_PROMISE's) accepted before they are requested.
var serverName = proc.argv[2];
var replayDir = proc.argv[3];
var matching = (proc.argv[4] == 'true'); //Do dynamic matching
var pushing = (proc.argv[5] == 'true'); //Accept pushed resouces and LRP headers in 'push_urls.json'
var verbose = (proc.argv[6] == 'true'); //Whether to print out info about the requests/responses

function parseHTTPFiles(newRequestURI)
{
	//As of now, all objects are iteratied over in searching.
	//However, it is async for each request.
	//May want to further optimize in future.
	return new Promise(function(resolve, reject){
	 	
		fs.readdir(replayDir, function(dirErr, replayFileNames){
			
			//Globals for the matching process
			var bestRecordObj = null;
			var maxScore = -10;
			var currScore = 0;
			
			//Simultaneously read all JSON files and resolve when all have been checked
			function readHTTPFiles(jsonRecordFile){
				return new Promise(function(resolve, reject){
					fs.readFile(replayDir + jsonRecordFile, 'utf-8', function(readErr, httpRecordInfo){		
						if(!readErr)
						{						
							//Strip protocol and domain name 
							// i.e. left with just the URI
							var httpRecordObj = JSON.parse(httpRecordInfo);
							var originalRequest = httpRecordObj.requestURL;
							var originalRequestURI = originalRequest.split("/");
							originalRequestURI.shift();
							originalRequestURI.shift();
							originalRequestURI.shift();
							originalRequestURI = originalRequestURI.join("/");
							originalRequestURI = "/" + originalRequestURI;
							
							//Check for match
							if(matching)
							{
								currScore = fsm(newRequestURI, originalRequestURI);
								if(currScore >= maxScore) //Order not guarenteed since this is async, if two urls are satisfied either may be assigned depending on execution order.
								{
									maxScore = currScore;
									bestRecordObj = httpRecordObj;
								}
							}
							else
							{
								if(newRequestURI == originalRequestURI) //Direct string url matching. Again, assignment order not guarenteed in case of the same url requested twice.
								{
									maxScore = 1;
									bestRecordObj = httpRecordObj;
								}
							}
						
							//The file read resolution
							resolve("JSON HTTP File Read successfully");
						}
						else
						{
							reject("Could not read JSON File " + jsonRecordFile);
						}
					});
				});
			}
			
			var readHTTPPromises = [];
			for (var fileID in replayFileNames)
			{
				var jsonRecordFile = replayFileNames[fileID];
				readHTTPPromises.push(readHTTPFiles(jsonRecordFile));
			}
			
			Promise.all(readHTTPPromises).then(function(readSuccessesArray){
			
				if(maxScore > 0)
				{
					//The resolution to parse HTTP files
					if(verbose)
					{
						console.log("Matched: " + newRequestURI + " with " + bestRecordObj.requestURL);
					}
					resolve(bestRecordObj);
				}
				else
				{
					reject("No Match obtained for request " + newRequestURI);
				}
			}, function(readRejectionArray){
				reject("A read error ocurred with one or more JSON HTTP record files for request " + newRequestURI);
			});
		});
	});
}

function onRequest_Insecure(request, response)
{
	parseHTTPFiles(request.url).then(function(recordObj){
		
		//Some sites have requests are hard coded to be served under plain http://
		//This will deliver the objects under HTTP 1.1 instead of HTTP/2 since Chrome (and other modern browsers) reject insecure HTTP/2 
		
		//Uncomment the below lines if you want to send HTTP headers other than the date, which is the default header sent by node.
		//var responseHeaders = recordObj.responseHeaders;
		//response.writeHead(200, responseHeaders);
		response.writeHead(200);
		if(recordObj.responseBase64 == false)
		{			
			response.write(recordObj.responseBody);
		}
		else
		{
			response.write(Buffer.from(recordObj.responseBody, 'base64'));
		}
		response.end();	

	}, function(rejectString){

		if(verbose)
		{
			console.log(rejectString);
		}
		response.writeHead(404);
		response.end();

	});
}

function onRequest(request, response)
{
	parseHTTPFiles(request.url).then(function(recordObj){
				
		//Set of deprecated headers.
		//Most are used only for HTTP 1.1, and will be rejected by node.
		//Others will cause the resource to not be loaded (such as Content-Encoding since we are do not gzip anything here).
		//Uncomment the below lines you want to send HTTP headers other than the date, which is the default header sent by node.
		//	NOTE: This set of rejected headers is incomplete and was determined experimentally. May be a full list within the protocl spec.
		//var responseHeaders = recordObj.responseHeaders;
		//delete responseHeaders['Connection'];
		//delete responseHeaders['connection'];
		//delete responseHeaders['Content-Encoding']
		//delete responseHeaders['content-encoding'];
		//delete responseHeaders['Keep-Alive'];
		//delete responseHeaders['keep-alive'];
		//delete responseHeaders['content-security-policy'];
		//delete responseHeaders['Content-Security-Policy'];
		//delete responseHeaders['transfer-encoding'];
		//delete responseHeaders['Transfer-Encoding'];
		//response.writeHead(200, responseHeaders);
		
		if(!pushing)
		{
			response.writeHead(200);
			if(recordObj.responseBase64 == false)
			{
				//For most files
				response.write(recordObj.responseBody);
			}
			else
			{
				//Images on the web are almost always base 64 encoded
				response.write(Buffer.from(recordObj.responseBody, 'base64'));
			}
			response.end();	
		}
		else
		{
			//Check if this is the main HTML
			var originalRequest = recordObj.requestURL;
			var originalRequestURI = originalRequest.split("/");
			originalRequestURI.shift();
			originalRequestURI.shift();
			originalRequestURI.shift();
			originalRequestURI = originalRequestURI.join("/");
			originalRequestURI = "/" + originalRequestURI;
			
			if(request.url == "/")
			{
				//Send the http and then the list of pushed objects
				//The HTML transfer
				var pushHeaders = [];
				pushHeaders['link'] = link_header; //LRP headers on the main HTML see https://w3c.github.io/preload/
								
				//Now find each of the objects to push and push them
				//Look up the pushes in parallel and write them over the wire when they are all found.
				var find_record_promise_array = [];
				for(var i = 0; i < push_urls_array.length; i++)
				{
					var curr_push_url = push_urls_array[i];
					
					//Assume using full URL syntax (i.e. authority and path), will strip down to URI here.
					curr_push_url = curr_push_url.split("/");
					curr_push_url.shift();
					curr_push_url.shift();
					curr_push_url.shift();
					curr_push_url = curr_push_url.join("/");
					curr_push_url = "/" + curr_push_url;
					
					find_record_promise_array.push(parseHTTPFiles(curr_push_url));					
				}
				
				Promise.all(find_record_promise_array).then(function(recordObjArray){
					for(var j = 0; j < recordObjArray.length; j++)
					{
						var currRecordObj = recordObjArray[j];
						var curr_push_url = push_urls_array[j].split("/");
						curr_push_url.shift();
						curr_push_url.shift();
						curr_push_url.shift();
						curr_push_url = curr_push_url.join("/");
						curr_push_url = "/" + curr_push_url;
						
						if(currRecordObj.responseBase64 == false)
						{	
							//Create the PUSH_PROMISE frame with the response.push() API
							//The URL parameter determines HTTP/2 ':path' and ':authority' pseudo-headers 
							//These are used by the client to match and accept the data being sent in the PUSH_PROMISE.
							var push = response.push(push_urls_array[j]);
							push.writeHead(200);
							
							//Actually send the data
							push.write(currRecordObj.responseBody);
							push.end();
						}
						else
						{
							var push = response.push(push_urls_array[j]);
							push.writeHead(200);
							push.write(Buffer.from(currRecordObj.responseBody, 'base64'));
							push.end();
						}
					}
					
					//Finally send the actual HTML data
					if(recordObj.responseBase64 == false)
					{
						response.end(recordObj.responseBody);
					}
					else
					{
						response.end(Buffer.from(recordObj.responseBody, 'base64'));
					}
				}, function(pushMatchFailString){
					
					//As it is now, if one of the pushes fail (i.e. there's no match), they all fail.
					if(verbose)
					{
						console.log(pushMatchFailString + " while pushing!");
					}
					
					//Still send the HTML as normal
					response.writeHead(200);
					if(recordObj.responseBase64 == false)
					{			
						response.write(recordObj.responseBody);
					}
					else
					{
						response.write(Buffer.from(recordObj.responseBody, 'base64'));
					}
					
				});
			}
			else
			{
				//A normal transfer
				if(recordObj.responseBase64 == false)
				{			
					response.write(recordObj.responseBody);
				}
				else
				{
					response.write(Buffer.from(recordObj.responseBody, 'base64'));
				}
				response.end();
			}
		}
	}, function(rejectString){

		if(verbose)
		{
			console.log(rejectString);
		}
		response.writeHead(404);
		response.end();

	});
}

var server_insecure = http.createServer(onRequest_Insecure);
var server = http2.createServer(ssl_options, onRequest);
server_insecure.listen(80);
server.listen(443);
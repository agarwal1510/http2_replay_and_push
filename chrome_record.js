//Conor Kelton
//chrome_record.js

//Communitcates to chrome via the CRI and Remote Debug API (see https://github.com/cyrus-and/chrome-remote-interface and https://chromedevtools.github.io/devtools-protocol/)
//Records all HTTP Request/Response flows in a file
//Runs a script to overload Math.random() and Date() for the page load. Also injects this script into the HTML for later replays.
//Formats as JSON object with fields given below
//Does so for all sites specified in a given '\n' delimited file

const CDP = require('chrome-remote-interface');
const util  = require('util');
const ps = require('process');
const exec = require('child_process').exec;
const spawn = require('child_process').spawn;
const proc = require('process');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio')

CDP(function(client) {

	const {Network, Page, Runtime} = client;

	var rootPath = proc.argv[2];
	var recordDomains = fs.readFileSync(proc.argv[3], 'utf-8').split("\n");
	for(var i = 0; i < recordDomains.length; i++)
	{
		recordDomains[i] = recordDomains[i].trim();
	}
	var pageWaitTime = proc.argv[4]; //Milliseconds to wait for each page to load while recording
	var deterministicJSString = fs.readFileSync(path.resolve('./deterministic.js'), 'utf8');

	//Globals
	var record_count = 0;
	var currDomain = "";
	var httpRequests = {}; //A map of unique Request ID's to Request Objects
	var httpResponses = {};

	//The object that will be written as the actual record
	function httpRecordObject() {
	    this.requestURL = "";
	    this.requestMethod = "";
	    this.requestHeaders = "";
	    this.requestPostData = "";
	    this.responseURL = "";
	    this.responseStatus = "";
	    this.responseStatusText = "";
	    this.responseProtocol = "";
	    this.responseBody = "";
	    this.responseBase64 = "";
	}

	//String format currently not used in favor of JSON serialization, but can be used for dumping
	function compileHTTPRecordString(httpRecordObj)
	{
		//Returns entire HTTP request response flow into a string which can be directly written to a file
		var fullHTTPRecordString = "";
		fullHTTPRecordString += httpRecordObj.requestMethod + " " + httpRecordObj.requestURL + " " + httpRecordObj.responseProtocol + "\r\n";
		fullHTTPRecordString += httpRecordObj.requestPostData + "\r\n";
		for(var header in httpRecordObj.requestHeaders)
		{
			if(httpRecordObj.requestHeaders.hasOwnProperty(header))
			{
				fullHTTPRecordString += header.toString() + ":" + httpRecordObj.requestHeaders[header] + "\r\n";
			}
		}
		fullHTTPRecordString += "\n"; //Request and response info separated by a single newline character

		fullHTTPRecordString += httpRecordObj.responseProtocol + " " + httpRecordObj.responseStatus + " " + httpRecordObj.responseStatusText + "\r\n";
		for(var header in httpRecordObj.responseHeaders)
		{
			if(httpRecordObj.responseHeaders.hasOwnProperty(header))
			{
				fullHTTPRecordString += header.toString() + ":" + httpRecordObj.responseHeaders[header] + "\r\n";
			}
		}
		fullHTTPRecordString += "\r\n";

		if(httpRecordObj.responseBase64 == true)
		{
			fullHTTPRecordString += Buffer.from(httpRecordObj.responseBody, 'base64').toString('utf8');
		}
		else
		{
			fullHTTPRecordString += httpRecordObj.responseBody;
		}

		return(fullHTTPRecordString);
	}

	function writeHTTPSync(requestID, httpRecordFile, httpRecordObj){

		//Writes the file to the system in a specified global directory and under the current website url
		// as specified in recordDomains
		var jsonHTTPRecord = JSON.stringify(httpRecordObj);
		console.log("Writing RequestID " + requestID);
		
		//Inject deterministic js into main HTML
		var potentialURI = httpRecordObj.requestURL.split("/");
		potentialURI.shift();
		potentialURI.shift();
		potentialURI.shift();
		potentialURI = potentialURI.join("/");
		potentialURI = "/" + potentialURI;
		
		//Check to see if this is the response corresponding to the main HTML
		//The request for this will only be the domain name.
		if(potentialURI == "/")
		{
			//Parse the response HTML using the cheerio package
			var mainHTML = httpRecordObj.responseBody;
			const $ = cheerio.load(mainHTML);
			$('head').prepend('<script> ' + deterministicJSString + '\n </script>');
			
			var injectedMainHTML = $.html();
			httpRecordObj.responseBody = injectedMainHTML;			
		}
		
		fs.writeFileSync(httpRecordFile, JSON.stringify(httpRecordObj), 'utf8');
		if(httpRecordObj.responseBody != "")
		{
			return(true);
		}
		else
		{
			console.log("No response body for request " + requestID);
			return(false);
		}
		
	}

	function storeHTTPRequest(requestData)
	{

		var requestID = requestData.requestId;
		var requestObject = requestData.request;
		httpRequests[requestID] = requestObject;
		return;

	}

	function storeHTTPResponse(responseData)
	{

		var responseRequestID = responseData.requestId;
		var responseObject = responseData.response;
		httpResponses[responseRequestID] = responseObject;
		return;

	}
	
	function recordHTTPFlows()
	{

		//Assumes the page is done loading.
		//Goes through each request and finds the appropriate response
		//Writes the pair as a JSON object to a file
		return new Promise(function(resolve, reject){

			function recordLoop(requestID)
			{
				return new Promise(function(res, rej){
					console.log(requestID);
					var httpRecordObj = new httpRecordObject();

					//First Obtain all the request information for this response
					//Note that there are other data, such as if there were pushes involved in the page load, but for now we won't parse this info.
					var request = httpRequests[requestID];
					var response = httpResponses[requestID]; //The unique requestID corresponding to this response
					
					//If there was nothing saved for either move on
					if(!request || !response)
					{
						console.log("No URL Found for Request ID");
						res();
					}
					httpRecordObj.requestURL = request.url;
					httpRecordObj.requestMethod = request.method;
					httpRecordObj.requestHeaders = request.headers; //JSON object of headers, each header is a key mapped to its header value
					httpRecordObj.requestPostData = request.postData;

					//Now store the necessary response information
					httpRecordObj.responseURL = response.url;
					httpRecordObj.responseStatus = response.status;
					httpRecordObj.responseStatusText = response.statusText;
					httpRecordObj.responseProtocol = response.protocol;
					httpRecordObj.responseHeaders = response.headers;

					//Obtain the data for this response async
					Network.getResponseBody({"requestId":requestID}).then(function (responseData){

						httpRecordObj.responseBody = responseData.body;
						httpRecordObj.responseBase64 = responseData.base64Encoded;
						var domainNameOnly = currDomain.split("/")[2]; //Global current domain. Consider Refactoring
						var httpRecordFile = rootPath + domainNameOnly + "/" + requestID + ".json"; //Unique request identifier for file
						
						var writeStatus = writeHTTPSync(requestID, httpRecordFile, httpRecordObj);
						
						if(writeStatus == true)
						{
							console.log("successfully wrote http record for request " + requestID + "\n");
							res();
						}
						else
						{
							console.log("failed to write http record for request " + requestID + "\n");
							res(); //TODO: Actually handle this rejection case
						}

					}, function(bodyError){
						console.log("No Body Found for Request ID");
						res();
					});
				});
			}

			//Create a promise chain of websites to do create http records for
			var domainNameOnly = currDomain.split("/")[2];
			var httpRecordDir = rootPath + domainNameOnly;
			fs.mkdirSync(httpRecordDir);

			var write_fct_array = [];
	        for(var requestID in httpRequests)
	        {
	        	//console.log("adding function!");
	            write_fct_array.push(recordLoop(requestID));
	        }

	        Promise.all(write_fct_array).then(resolve);
    	});			
	}

	//Kills the debug connection and hence the record script
    function killConnection()
    {
    	client.close();
    }

	function newPage()
    {
        return new Promise(function(resolve, reject){
            
            Page.navigate({url: 'data:,'}).then(function(){
                if(true)
                {
                    resolve("Page Navigated Successfully");
                }
                else
                {
                    reject("Page Navigation Failure");
                }

            });
        });
    }

	function pageNav(next_url)
    {
        return new Promise(function(resolve, reject){

            Page.navigate({url: next_url}).then(function(){
                if(true)
                {
                    resolve("Page Navigated Successfully");
                }
                else
                {
                    reject("Page Navigation Failure");
                }

            });
        });
    }

	function mainFlow()
	{
		//The actual record replay loop
		//Called after each record session resolves
		function doHttpRecord()
		{
			return new Promise(function(resolve, reject){

				currDomain = "filler";

				//Unload the page by loading a dummy page
				newPage().then(function(res1){

					currDomain = recordDomains[record_count]; //Global call, should bind. Requires refactoring.

					//Actually load the page we are interested in
					pageNav(currDomain).then(function(res2){

						setTimeout(function(){

							//Consider the recording session completed
							if(true)
							{
								recordHTTPFlows().then(function(res3){
									console.log("Completing!");
									record_count++; //Global incrementor, should bind. Requres refactoring.
									httpRequests = {}; //Clear the flow info. should bind. Requres refactoring.
									httpResponses = {};
									resolve("Completed A Record Replay Iteration");
								});
							}
							else
							{
								reject("Unable to record this session");
							}

						}, pageWaitTime) //Static wait time defined above, TODO: Pass this param in for each site

					});
				});
			});
		}

		//Create a chain of anonymous functions for the number of sites we need to record
		var record_fct_array = [];
        for(var i = 0; i < recordDomains.length; i++)
        {
            record_fct_array.push(doHttpRecord);
        }

        let record_chain = Promise.resolve(); //Root of the chain
        for(var j = 0; j <= record_fct_array.length; j++)
        {
            if(j < record_fct_array.length)
            {
                record_chain = record_chain.then(record_fct_array[j]); //Execute the function. Reveal it returns a Promise
            }
            else if(j == record_fct_array.length)
            {
                record_chain = record_chain.then(killConnection); //Final anon to kill the script
            }
        }
	}

	//Bind a callback to the http response event
	Network.requestWillBeSent(storeHTTPRequest); 
	Network.responseReceived(storeHTTPResponse);
	
	//Add the deterministic script to the page load
	Page.addScriptToEvaluateOnLoad({'scriptSource':deterministicJSString});
	
	//Begin the recording process
	Promise.all([Network.enable(),Page.enable(),Runtime.enable()]).then(mainFlow);


}).on('error', function(err){
        console.error('Cannot connect to remote endpoint:', err);
});
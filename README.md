# http2_replay_and_push
Repository containing scripts for aiding in recording and replaying of sites in HTTP/2 with the ability to Server Push objects. 

Usage:
----------
(All code below tested on Ubuntu 14.04)

A) Recording

The Web site recording works by utlizing the Chrome Dev Tools protocol wrapper for NodeJS (see https://github.com/cyrus-and/chrome-remote-interface and https://chromedevtools.github.io/devtools-protocol/).
It records all HTTP request/responses sent out by chrome in JSON format.
It will inject and execute the 'determinstic.js' (as taken from Web Page Replay) script into the page during recording, so dynamic URLS determined by Math.random() and Date() will be deterministic. (It will also store this in the main HTML of the page so subsequent replays will follow the same Math.random() and Date() overloads).

To record a site first open google chrome with the remote debug port open:

    google-chrome --remote-debugging-port=9222 --user-data-dir --incognito 

(incognito is used to prevent caching so all requests are actually sent over the network)
(9222 is the default TCP port for remote debug communications)

To proceed to recording HTTP Traffic of multiple sites at once run 'chrome_record.js' as follows:
'''
node chrome_record.js ./chrome_http_records/ ./sites.txt 20000
'''

Argument Explanation:
1) './chrome_http_records/' : Directory of were to store each record session (under each name provided in the second argument file)
2) './sites.txt' : "\n" delimited file of fully qualified domain names of sites to record. A new directory will be created in the argument 1 directory corresponding to each line in this file.
3) '20000' : Time to wait for the site to load before committing HTTP requests to file, in milliseconds

B) Replaying

First open chrome with the following flags:
'''
google-chrome --user-data-dir --incognito --ignore-certificate-errors --disable-web-security --allow-running-insecure-content &

'''
(--ignore-certificate-errors is so an SSL certificate can satisfy multiple domains without crashing chrome)
(--disable-web=security is so Cross origin resources are loaded without the necessary HTTP headers)
(--allow-running-insecure-content allows our replay server to be accessed by http:// and https:// requests, though HTTP/2 is only delivered under TLS)


Then run the server:

'''
node http2_replay_server.js ebay.com ./chrome_http_records/ebay.com/ true false true
'''

Argument Explanation:
1) 'ebay.com' : The authority of the site to load.
2) './chrome_http_records/ebay.com/' : The directory of the stored objects from the replay 
(root access is likely needed to run on ports 80 and 443)
3) 'true' : A boolean of whether to use fuzzy matching or exact matching of urls (true for fuzzy matching).
4) 'false' : A boolean of whether or not objects will be pushed with the main HTML. (true for pushing objects).
The markup for pused objects is read from 'push_urls.json' with an example supplied.
5) 'true' : A boolean of whether or not to be verbose. Verbose setting will log what URLS are matched/not matched

Finally navigate to the domain specified in argument (1) in the open chrome instance.
If the site was recorded sucessfully it will be replayed as specified.

Notes:
--------
1) This sever does not automatically enable DNS spoofing. To do this, and thus to have requests for all authorities point to the replay seerver, use DNSMASQ or BIND, or even /etc/hosts if you know the domain authorities for all the site you are replaying

2) Cross Origin Pushes are currently blocked by Chrome.

3) This code is still very much 'research code' but should provide a good starting point for custom replaying of sites.

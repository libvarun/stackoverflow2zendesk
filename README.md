# Stackoverflow to Zendesk
NodeJS code to import new questions on Stackoverflow into Zendesk tickets

# Description
This simple NodeJS code will run every interval (default is 10 minutes) and get all new questions on Stackoverflow from a specific set of tags (semicolon separated). For each new question, will create a Zendesk end-user (if doesn't exists) and a new ticket (if doesn't exists). 

The ticket will have the question body (HTML Formated) and a simple header warning the Zendesk Agents (Support Staff) to asnwer on stackoverflow. Comments and answers posted on stackoverflow will not be copied/imported into Zendesk.

# Setup
Create a Zendesk account. The API is available on all plans (as of July, 2016). Create a API token (Settings>Channels>API). Edit the server.js with this information.

Create a Stackoverflow account. Create an app. Use the key (public) on the server.js. This is required in order to have a 10k daily request quota, otherwise will be shared on the IP. Include the tags you wish to monitor (semicolon separated).

On the command line, run the following:

    ' npm install
    ' node server.js
    
Done.
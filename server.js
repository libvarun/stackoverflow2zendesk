var request = require('request');
var zlib = require('zlib');
var cron = require('node-cron');
var trim = require('trim');
var zendesk = require('node-zendesk');
var htmlToText = require('html-to-text');

// SETUP: zendesk
var zendeskclient = zendesk.createClient({
    username: 'your user name here',
    token: 'your token here',
    remoteUri: 'https://YOUR_DOMAIN.zendesk.com/api/v2',
    //debug: true
});

// SETUP: Stackoverflow
// 1. tags being monitored
var TAGS = [
    'autodesk-forge',
    'autodesk-data-management',
    'autodesk-model-derivative',
    'autodesk-viewer',
    'autodesk-designautomation',
    'autodesk-3d-print'
];
// 2. developer key
var STACKOVERFLOW_DEVELOPER_KEY = 'your key here'; // this is used for quota (10k per day)

// 3. email alias of the portal (form)
var PORTAL_EMAIL_ALIAS = 'EMAIL FORM ALIAS';

// get new questions from stackoverflow every 10 minutes
cron.schedule('0,10,20,30,40,50 * * * *', function () {
    console.log('Searching for new questions - ' + (new Date()).toString());
    getNewQuestions();
});

// adjust questions from portal form every aprox. 3 minutes (10 calls per minute limitation)
cron.schedule('3,5,8,13,15,17,23,25,27,33,35,37,43,45,47,53,55,57 * * * *', function () {
    console.log('Analyzing tickets from portal - ' + (new Date()).toString());
    adjustQuestionsFromForgePortal();
});

function getNewQuestions() {
    // time range: 1 hour back
    // if we take several questions, then we need to check them all
    // on Zendesk, but there is a rate limit for calling Zendesk API
    // https://developer.zendesk.com/rest_api/docs/core/introduction#rate-limits
    var now = new Date();
    var before = new Date(now - 60000 * 60 * 1 /*hour*/);

    // create a list of tags
    //var listOfTags = TAGS.split(';');

    // stackoverflow return questions for 1 tag at a time
    // is we pass 2 or more tags, will return questions with all tags
    // so let's create a list and store all questions for all
    // monitored tags. once all requests are done, proccess them
    var listOfQuestions = {};
    var pendingRequests = 0;
    TAGS.forEach(function (tag, index) {
        var url = 'https://api.stackexchange.com/2.2/questions?fromdate=' + Math.floor(before.getTime() / 1000)
            + '&todate=' + Math.floor(now.getTime() / 1000)
            + '&order=desc&sort=activity&tagged=' + tag
            + '&site=stackoverflow&filter=withbody';

        pendingRequests++;
        makeRequest(url, function (res) {
            if (res != null && res.items != null) {
                res.items.forEach(function (question) {
                    listOfQuestions[question.question_id] = question;
                });
                pendingRequests--;
                if (pendingRequests == 0) {
                    // all requests are done, let' process
                    processQuestions(listOfQuestions);
                }
            }
        });
    });
}

function processQuestions(questions) {
    for (var id in questions) {
        (function (question) { // this access mutable variable from closure
            console.log('\tChecking question ' + question.question_id);
            var stackuser = question.owner;
            // get or create zendesk user for this question
            getZendeskUser(stackuser, function (zendeskuser) {
                if (zendeskuser != null) {
                    // get or create zendesk ticket
                    createZendeskTicket(question, zendeskuser, function (ticket) {
                        // all set
                    })
                }
            });
        })(questions[id]);
    }
}

function getZendeskUser(stackuser, onuser) {
    // first check if the user exists...
    zendeskclient.users.search({external_id: stackuser.user_id}, function (err, req, users) {
        if (users != null && users.length == 0) {
            // if not, then create
            // (use stackoverflow user ID as zendesk end-user external ID
            var user = {
                'user': {
                    'name': stackuser.display_name,
                    'external_id': stackuser.user_id,
                    'role': 'end-user',
                    'verified': 'true',
                    'remote_photo_url': stackuser.profile_image,
                    'user_fields': {
                        'stackoverflow_profile': stackuser.link
                    },
                }
            };
            zendeskclient.users.create(user, function (err, req, newuser) {
                console.log('\tNew end-user for user ' + stackuser.user_id);
                onuser(newuser);
            });
        }
        else {
            onuser(users != null ? users[0] : null);
        }
    });
}

function createZendeskTicket(stackquestion, zendeskuser, onnewticket) {
    // check if the question is already logged (as a ticket)
    zendeskclient.tickets.show({external_id: stackquestion.question_id}, function (err, req, tickets) {
        if (tickets != null && tickets.length == 0) {
            // if not, create a new ticket with the question information
            // (use stackoverflow question ID as zendesk ticket external ID
            var ticket =
            {
                "ticket": {
                    "subject": htmlToText.fromString(stackquestion.title),
                    "comment": {
                        "html_body": // this header will remember agents to not reply on zendesk UI
                        '<h3><span style="color: red">IMPORTANT:</span> answer at '
                        + '<a href="' + stackquestion.link + '" target="_blank">Stackoverflow</a></h3>'
                        + '-----------------------------------------'
                        // the actual question body
                        + stackquestion.body,
                    },
                    'requester_id': zendeskuser.id,
                    'tags': stackquestion.tags,
                    'external_id': stackquestion.question_id,
                    // if it was already answered on Stackoverflow, just mark as SOLVED.
                    // if there are some answers, mark as OPEN
                    // otherwise mark as NEW
                    'status': (stackquestion.is_answered == true ? 'solved' : (stackquestion.answer_count > 0 ? 'open' : 'new')),
                    'created_at': new Date(stackquestion.creation_date * 1000).getTime(),
                }
            };
            zendeskclient.tickets.create(ticket, function (err, req, newticket) {
                console.log('\tNew ticket for question ' + stackquestion.question_id);
                if (err != null) console.log(err);
                onnewticket(newticket);
            });
        }
        else
            onnewticket(tickets == null ? null : tickets[0]);
    });
}

// util function for stackoverflow requests
function makeRequest(url, onsuccess) {
    request({
        url: url + '&key=' + STACKOVERFLOW_DEVELOPER_KEY,
        method: 'GET',
        gzip: true,
    }, function (error, response, body) {
        if (error != null) {
            console.log(error);
            onsuccess(null);
        } // connection problems

        if (body == null || body.errno != null || response.statusCode != 200) {
            console.log(body.quota_remaining);
            console.log(body.errors);
        }
        if (body.errno == null)
            body = JSON.parse(body);
        //console.log(body.quota_remaining);
        onsuccess(body);
    })
}

// this function will get questions that come from the Forge Dev Portal (by email) and change
// the requester to the email that sent the question, otherwise the replies will go to forge email alias
function adjustQuestionsFromForgePortal() {
    zendeskclient.search.query("type:ticket status:new requester:" + PORTAL_EMAIL_ALIAS, function (err, req, tickets) {
        tickets.forEach(function (ticket, index) {
            // now the ticket is recoverd, let's change the requested ID based on the
            // email of the user who sent the question
            // first let's "parse" the body of the request
            var props = {};

            var params = ticket.description.split('\n');
            params.forEach(function (param, index) {
                if (index < 3) { // just name, email, API
                    param = param.split(':');
                    props[trim(param[0]).replace(/[\'_ ]/g, '')] = trim(param[1]);
                }
            });

            // now check if there is a user with this email account
            var query = 'type:user email:' + props['UsersEmail'];
            zendeskclient.users.search({query: query}, function (err, req, users) {
                var emailuser = (users != null && users.length > 0 ? users[0] : null);

                // if not user yet, let's create it
                if (emailuser == null) {
                    var user = {
                        'user': {
                            'name': props['UsersName'],
                            'role': 'end-user',
                            'verified': 'true',
                            'email': props['UsersEmail'],
                        }
                    };
                    zendeskclient.users.create(user, function (err, req, newuser) {
                        if (err!=null){
                            console.log(err);
                            return;
                        }
                        console.log('\tNew end-user for user ' + props['UsersEmail']);
                        emailuser = newuser;
                    });
                }

                // now that we have the user, let's update the ticket
                if (emailuser != null) {
                    var tags = [];
                    tags.push(props['WhichAPI'].replace(/[ ]/g, '-').toLowerCase());
                    var updateTicketInfo = {
                        "ticket": {
                            "requester_id": emailuser.id,
                            "tags": tags,
                        }
                    };

                    zendeskclient.tickets.update(ticket.id, updateTicketInfo, function (err, req, updatedTicket) {
                        if (updatedTicket == null) {
                            console.log(err);
                            return;
                        }

                        if (err == null)
                            console.log('Form ticket ' + updatedTicket.id + ' adjusted for user: ' + emailuser.email);
                    });
                }
            });
        });
    });
}

console.log('Running for tags: ' + TAGS.join(';'));
